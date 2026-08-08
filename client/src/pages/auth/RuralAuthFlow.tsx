import { useState } from "react";
import { useLocation } from "wouter";
import { KeyRound, Loader2, Lock, Phone } from "lucide-react";

import doorstepLogo from "@/assets/doorstep-ds-logo.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, resetCsrfTokenCache } from "@/lib/queryClient";

/**
 * The retained component name avoids changing routing, but this is now a local
 * phone + four-digit PIN screen. It has no Firebase, reCAPTCHA or password flow.
 */
export default function RuralAuthFlow() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [phone, setPhone] = useState(() => localStorage.getItem("lastPhone") ?? "");
  const [pin, setPin] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const signIn = async () => {
    if (!/^\d{10}$/.test(phone)) {
      toast({ title: "Invalid mobile number", description: "Enter a 10-digit mobile number.", variant: "destructive" });
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      toast({ title: "Invalid PIN", description: "Enter the 4-digit PIN from your local auth config.", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiRequest("POST", "/api/auth/login-pin", {
        phone,
        pin,
      });
      const user = await response.json();
      localStorage.setItem("lastPhone", phone);
      resetCsrfTokenCache();
      queryClient.setQueryData(["/api/user"], user);
      const destination = user.role === "worker" ? "/shop" : `/${user.role || "customer"}`;
      setLocation(destination);
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
            <p className="mt-2 text-sm text-slate-300">Sign in with your mobile number and 4-digit PIN.</p>
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

            <div className="space-y-2">
              <Label htmlFor="local-pin" className="text-slate-100"><Lock className="mr-2 inline h-4 w-4" />4-digit PIN</Label>
              <Input
                id="local-pin"
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={4}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
                onKeyDown={(event) => { if (event.key === "Enter") void signIn(); }}
                placeholder="••••"
                className="h-12 border-white/20 bg-white/10 text-center text-2xl tracking-[0.5em] text-white placeholder:text-slate-400"
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
