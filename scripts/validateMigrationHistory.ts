import fs from "node:fs/promises";
import path from "node:path";

type JournalEntry = {
  idx: number;
  tag: string;
};

type Journal = {
  entries: JournalEntry[];
};

const migrationsDir = path.resolve(process.cwd(), "migrations");
const metaDir = path.join(migrationsDir, "meta");

async function main() {
  const journalPath = path.join(metaDir, "_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as Journal;
  const errors: string[] = [];

  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const tags = new Set<string>();

  entries.forEach((entry, expectedIdx) => {
    if (entry.idx !== expectedIdx) {
      errors.push(
        `Journal index ${entry.idx} is out of sequence; expected ${expectedIdx}.`,
      );
    }
    if (tags.has(entry.tag)) {
      errors.push(`Duplicate migration tag: ${entry.tag}`);
    }
    tags.add(entry.tag);
  });

  for (const entry of entries) {
    const migrationPath = path.join(migrationsDir, `${entry.tag}.sql`);
    try {
      await fs.access(migrationPath);
    } catch {
      errors.push(`Journal entry has no SQL file: ${entry.tag}.sql`);
    }
  }

  const snapshotFiles = (await fs.readdir(metaDir)).filter((fileName) =>
    /^\d{4}_snapshot\.json$/.test(fileName),
  );
  if (snapshotFiles.length === 0) {
    errors.push("No Drizzle snapshots were found in migrations/meta.");
  }

  const latestEntry = entries.at(-1);
  const latestSnapshot = snapshotFiles
    .map((fileName) => Number.parseInt(fileName.slice(0, 4), 10))
    .sort((a, b) => b - a)[0];
  if (latestEntry && latestSnapshot !== latestEntry.idx) {
    console.warn(
      `Migration journal ends at index ${latestEntry.idx}, while generated snapshots end at index ${latestSnapshot}. Manual SQL migrations may not have snapshots; db:migrate:baseline will fall back safely.`,
    );
  }

  const sqlFiles = (await fs.readdir(migrationsDir)).filter((fileName) =>
    fileName.endsWith(".sql"),
  );
  const orphanFiles = sqlFiles.filter(
    (fileName) => !tags.has(fileName.slice(0, -4)),
  );
  if (orphanFiles.length > 0) {
    console.warn(
      `Found ${orphanFiles.length} legacy SQL file(s) outside the active journal. They are retained as historical references and are not applied by Drizzle.`,
    );
  }

  if (errors.length > 0) {
    for (const error of errors)
      console.error(`Migration history error: ${error}`);
    process.exitCode = 1;
    return;
  }

  console.info(
    `Migration history is structurally valid (${entries.length} journal entries, ${snapshotFiles.length} snapshots).`,
  );
}

void main().catch((error) => {
  console.error("Migration history validation failed", error);
  process.exitCode = 1;
});
