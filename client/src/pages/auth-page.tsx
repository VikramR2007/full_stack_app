import { useEffect } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";

import RuralAuthFlow from "./auth/RuralAuthFlow";

export default function AuthPage() {
  const {
    user,
    isFetching: authIsFetching,
  } = useAuth();
  const [, setLocation] = useLocation();

  const shouldRedirect =
    user &&
    !authIsFetching;

  useEffect(() => {
    if (shouldRedirect) {
      const targetPath = user.role === "worker" ? "/shop" : `/${user.role || "customer"}`;
      setLocation(targetPath);
    }
  }, [
    user,
    authIsFetching,
    setLocation,
    shouldRedirect,
  ]);

  if (shouldRedirect) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
      </div>
    );
  }

  return <RuralAuthFlow />;
}
