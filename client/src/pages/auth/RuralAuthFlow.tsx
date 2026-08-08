import { useState } from "react";
import { useLocation } from "wouter";
import { KeyRound, Loader2, Lock, Phone } from "lucide-react";

import doorstepLogo from "@/assets/doorstep-ds-logo.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, resetCsrfTokenCache } from "@/lib/queryClient";

interface RuralAuthFlowProps {
  onSuccess?: () => void;
  onForgotPassword?: () => void;
}

/**
 * The retained component name avoids changing routing, but this is now a local
 * phone/password (or configured OTP) screen. It has no Firebase, reCAPTCHA or
 * browser permission dependency.
 */
export default function RuralAuthFlow({ onSuccess }: RuralAuthFlowProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [phone, setPhone] = useState(() => localStorage.getItem("lastPhone") ?? "");
  const [secret, setSecret] = useState("");
  const [method, setMethod] = useState<"password" | "otp">("password");
  const [isLoading, setIsLoading] = useState(false);

  const signIn = async () => {
    if (!/^\d{10}$/.test(phone)) {
      toast({ title: "Invalid mobile number", description: "Enter a 10-digit mobile number.", variant: "destructive" });
      return;
    }
    if (method === "password" && secret.length < 8) {
      toast({ title: "Invalid password", description: "Enter the password from your local auth config.", variant: "destructive" });
      return;
    }
    if (method === "otp" && !/^\d{6}$/.test(secret)) {
      toast({ title: "Invalid OTP", description: "Enter the 6-digit OTP from your local auth config.", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiRequest("POST", "/api/auth/local/login", {
        phone,
        [method]: secret,
      });
      const user = await response.json();
      localStorage.setItem("lastPhone", phone);
      resetCsrfTokenCache();
      queryClient.setQueryData(["/api/user"], user);
      const destination = user.role === "worker" ? "/shop" : `/${user.role || "customer"}`;
      setLocation(destination);
      onSuccess?.();
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Unable to sign in";
      toast({ title: "Sign-in failed", description: message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-orange-950 px-4 py-10">
      <section className="mx-auto flex min-h-[80vh] w-full max-w-md items-center">
        <div className="w-full rounded-3xl border border-white/15 bg-white/10 p-8 shadow-2xl backdrop-blur-xl">
          <div className="mb-8 text-center">
            <img src={doorstepLogo} alt="DoorStep" className="mx-auto mb-5 h-20 w-20 rounded-2xl" />
            <h1 className="text-3xl font-bold text-white">Welcome to DoorStep</h1>
            <p className="mt-2 text-sm text-slate-300">Sign in with the account in your local auth config.</p>
          </div>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="local-phone" className="text-slate-100"><Phone className="mr-2 inline h-4 w-4" />Mobile number</Label>
              <Input
                id="local-phone"
                inputMode="numeric"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 10))}
                placeholder="9876543210"
                className="h-12 border-white/20 bg-white/10 text-white placeholder:text-slate-400"
              />
            </div>

            <div className="grid grid-cols-2 rounded-xl bg-black/20 p-1">
              {(["password", "otp"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => { setMethod(option); setSecret(""); }}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${method === option ? "bg-orange-500 text-white" : "text-slate-300"}`}
                >
                  {option === "password" ? "Password" : "Local OTP"}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <Label htmlFor="local-secret" className="text-slate-100"><Lock className="mr-2 inline h-4 w-4" />{method === "password" ? "Password" : "6-digit OTP"}</Label>
              <Input
                id="local-secret"
                type="password"
                inputMode={method === "otp" ? "numeric" : "text"}
                autoComplete={method === "password" ? "current-password" : "one-time-code"}
                value={secret}
                onChange={(event) => setSecret(method === "otp" ? event.target.value.replace(/\D/g, "").slice(0, 6) : event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void signIn(); }}
                placeholder={method === "password" ? "Your configured password" : "123456"}
                className="h-12 border-white/20 bg-white/10 text-white placeholder:text-slate-400"
              />
            </div>

            <Button onClick={() => void signIn()} disabled={isLoading} className="h-12 w-full bg-orange-500 text-base hover:bg-orange-600">
              {isLoading ? <Loader2 className="animate-spin" /> : <><KeyRound className="mr-2 h-4 w-4" />Sign in</>}
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
