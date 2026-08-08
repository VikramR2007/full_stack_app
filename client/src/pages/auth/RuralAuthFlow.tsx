import { useState } from "react";
import { useLocation } from "wouter";
import { KeyRound, Loader2, Lock, Phone, Send, UserPlus } from "lucide-react";

import doorstepLogo from "@/assets/doorstep-ds-logo.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, resetCsrfTokenCache } from "@/lib/queryClient";

type AuthMode = "login" | "register";
type SignupRole = "customer" | "provider" | "shop";

const roleOptions: Array<{ value: SignupRole; label: string; description: string }> = [
  { value: "customer", label: "Customer", description: "Book nearby services and products" },
  { value: "provider", label: "Service provider", description: "Offer your services" },
  { value: "shop", label: "Shop owner", description: "Manage your storefront" },
];

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Request failed";
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    return parsed.message || raw;
  } catch {
    return raw;
  }
}

export default function RuralAuthFlow() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [mode, setMode] = useState<AuthMode>("login");
  const [phone, setPhone] = useState(() => localStorage.getItem("lastPhone") ?? "");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [otp, setOtp] = useState("");
  const [role, setRole] = useState<SignupRole>("customer");
  const [otpHint, setOtpHint] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSendingOtp, setIsSendingOtp] = useState(false);

  const goToRole = (user: { role?: string | null }) => {
    const destination = user.role === "worker" ? "/shop" : `/${user.role || "customer"}`;
    setLocation(destination);
  };

  const requestSignupOtp = async () => {
    if (!/^\d{10}$/.test(phone)) {
      toast({ title: "Invalid mobile number", description: "Enter a 10-digit mobile number first.", variant: "destructive" });
      return;
    }

    setIsSendingOtp(true);
    try {
      const response = await apiRequest("POST", "/api/auth/request-signup-otp", { phone });
      const payload = await response.json() as { developmentOtp?: string; message?: string };
      if (payload.developmentOtp) {
        setOtp(payload.developmentOtp);
        setOtpHint(`Local development OTP: ${payload.developmentOtp}`);
      } else {
        setOtpHint(payload.message || "OTP sent. Enter the code you received.");
      }
      toast({ title: "OTP ready", description: payload.developmentOtp ? "The local OTP was filled in for you." : payload.message });
    } catch (error) {
      toast({ title: "Could not send OTP", description: errorMessage(error), variant: "destructive" });
    } finally {
      setIsSendingOtp(false);
    }
  };

  const submit = async () => {
    if (!/^\d{10}$/.test(phone)) {
      toast({ title: "Invalid mobile number", description: "Enter a 10-digit mobile number.", variant: "destructive" });
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      toast({ title: "Invalid PIN", description: "Enter a 4-digit PIN.", variant: "destructive" });
      return;
    }

    if (mode === "register") {
      if (!name.trim()) {
        toast({ title: "Name required", description: "Enter your name.", variant: "destructive" });
        return;
      }
      if (pin !== confirmPin) {
        toast({ title: "PINs do not match", description: "Enter the same PIN twice.", variant: "destructive" });
        return;
      }
      if (!/^\d{6}$/.test(otp)) {
        toast({ title: "Invalid OTP", description: "Request and enter the 6-digit OTP.", variant: "destructive" });
        return;
      }
    }

    setIsLoading(true);
    try {
      const response = mode === "login"
        ? await apiRequest("POST", "/api/auth/login-pin", { phone, pin })
        : await apiRequest("POST", "/api/auth/rural-register", {
            phone,
            name: name.trim(),
            pin,
            otp,
            initialRole: role,
            language: "en",
          });
      const user = await response.json();
      localStorage.setItem("lastPhone", phone);
      resetCsrfTokenCache();
      queryClient.setQueryData(["/api/user"], user);
      goToRole(user);
    } catch (error) {
      toast({ title: mode === "login" ? "Sign-in failed" : "Registration failed", description: errorMessage(error), variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setOtpHint("");
    setOtp("");
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-orange-950 px-4 py-10">
      <section className="mx-auto flex min-h-[80vh] w-full max-w-md items-center">
        <div className="w-full rounded-3xl border border-white/15 bg-white/10 p-8 shadow-2xl backdrop-blur-xl">
          <div className="mb-6 text-center">
            <img src={doorstepLogo} alt="DoorStep" className="mx-auto mb-5 h-20 w-20 rounded-2xl" />
            <h1 className="text-3xl font-bold text-white">Welcome to DoorStep</h1>
            <p className="mt-2 text-sm text-slate-300">
              {mode === "login" ? "Sign in with your mobile number and 4-digit PIN." : "Create an account with phone verification and a 4-digit PIN."}
            </p>
          </div>

          <div className="mb-6 grid grid-cols-2 rounded-xl border border-white/15 bg-black/10 p-1">
            <button type="button" onClick={() => switchMode("login")} className={`rounded-lg px-3 py-2 text-sm font-medium ${mode === "login" ? "bg-orange-500 text-white" : "text-slate-300"}`}>
              <KeyRound className="mr-1 inline h-4 w-4" /> Sign in
            </button>
            <button type="button" onClick={() => switchMode("register")} className={`rounded-lg px-3 py-2 text-sm font-medium ${mode === "register" ? "bg-orange-500 text-white" : "text-slate-300"}`}>
              <UserPlus className="mr-1 inline h-4 w-4" /> Create account
            </button>
          </div>

          <div className="space-y-5">
            {mode === "register" && (
              <div className="space-y-2">
                <Label htmlFor="local-name" className="text-slate-100">Full name</Label>
                <Input id="local-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" className="h-12 border-white/20 bg-white/10 text-white placeholder:text-slate-400" />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="local-phone" className="text-slate-100"><Phone className="mr-2 inline h-4 w-4" />Mobile number</Label>
              <Input id="local-phone" inputMode="numeric" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="9876543210" className="h-12 border-white/20 bg-white/10 text-white placeholder:text-slate-400" />
            </div>

            {mode === "register" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="local-otp" className="text-slate-100">6-digit OTP</Label>
                  <Button type="button" variant="outline" size="sm" onClick={() => void requestSignupOtp()} disabled={isSendingOtp || isLoading} className="border-orange-300/50 bg-transparent text-orange-200 hover:bg-orange-500/20 hover:text-white">
                    {isSendingOtp ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />} Get OTP
                  </Button>
                </div>
                <Input id="local-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="123456" className="h-12 border-white/20 bg-white/10 text-center text-xl tracking-[0.35em] text-white placeholder:text-slate-400" />
                {otpHint && <p className="text-xs text-orange-200">{otpHint}</p>}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="local-pin" className="text-slate-100"><Lock className="mr-2 inline h-4 w-4" />4-digit PIN</Label>
              <Input id="local-pin" type="password" inputMode="numeric" autoComplete={mode === "login" ? "current-password" : "new-password"} maxLength={4} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="••••" className="h-12 border-white/20 bg-white/10 text-center text-2xl tracking-[0.5em] text-white placeholder:text-slate-400" />
            </div>

            {mode === "register" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="local-confirm-pin" className="text-slate-100">Confirm PIN</Label>
                  <Input id="local-confirm-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="••••" className="h-12 border-white/20 bg-white/10 text-center text-2xl tracking-[0.5em] text-white placeholder:text-slate-400" />
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-100">Choose account type</Label>
                  <div className="grid gap-2">
                    {roleOptions.map((option) => (
                      <button key={option.value} type="button" onClick={() => setRole(option.value)} className={`rounded-xl border p-3 text-left transition ${role === option.value ? "border-orange-300 bg-orange-500/20" : "border-white/15 bg-white/5 hover:bg-white/10"}`}>
                        <span className="block font-medium text-white">{option.label}</span>
                        <span className="block text-xs text-slate-300">{option.description}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-300">The selected provider/shop profile is created now; you can complete its details after signing in.</p>
                </div>
              </>
            )}

            <Button onClick={() => void submit()} disabled={isLoading || isSendingOtp} className="h-12 w-full bg-orange-500 text-base hover:bg-orange-600">
              {isLoading ? <Loader2 className="animate-spin" /> : mode === "login" ? <><KeyRound className="mr-2 h-4 w-4" />Sign in</> : <><UserPlus className="mr-2 h-4 w-4" />Create account</>}
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
