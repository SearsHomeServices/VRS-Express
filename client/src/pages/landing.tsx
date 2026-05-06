import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Redirect } from "wouter";
import searsLogo from "@assets/sears-home-services-logo-brands_1770949137899.png";

export default function LandingPage() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (user) {
    if (user.role === "admin" || user.role === "super_admin") return <Redirect to="/admin/dashboard" />;
    if (user.role === "vrs_agent") return <Redirect to="/agent/dashboard" />;
    return <Redirect to="/tech" />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background" data-testid="landing-page">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src={searsLogo} alt="Sears Home Services" className="h-12 mx-auto mb-4" data-testid="img-logo" />
          <h1 className="text-2xl font-bold" data-testid="text-landing-title">VRS Express</h1>
          <p className="text-sm text-muted-foreground mt-1">Sears Home Services</p>
        </div>

        <div className="space-y-3">
          <Button
            className="w-full"
            size="lg"
            onClick={() => setLocation("/tech/login")}
            data-testid="button-tech-entry"
          >
            Field Technician
          </Button>
          <Button
            className="w-full"
            size="lg"
            variant="secondary"
            onClick={() => setLocation("/agent/login")}
            data-testid="button-agent-entry"
          >
            VRS Agent
          </Button>
        </div>

        <div className="text-center mt-8">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setLocation("/admin/login")}
            data-testid="link-admin-entry"
          >
            Administrator
          </button>
        </div>
      </div>
    </div>
  );
}
