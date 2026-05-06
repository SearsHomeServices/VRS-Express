import { useState, useEffect } from "react";
import { useLocation, Redirect } from "wouter";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import searsLogo from "@assets/sears-home-services-logo-brands_1770949137899.png";

export default function TechLoginPage() {
  const [ldapId, setLdapId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [techInfo, setTechInfo] = useState<any>(null);
  const [phoneChanged, setPhoneChanged] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const { user, isLoading: authLoading, techLogin, login, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    if (user && user.role === "vrs_agent") {
      logout();
    }
  }, [user]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (user && user.role === "technician") return <Redirect to="/tech" />;
  if (user && (user.role === "admin" || user.role === "super_admin")) return <Redirect to="/tech" />;

  async function handleTechSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    try {
      if (showPasswordField) {
        const u = await login(ldapId.trim(), adminPassword);
        if (u.role === "admin" || u.role === "super_admin") {
          setLocation("/tech");
          return;
        }
        setLocation("/tech");
        return;
      }
      const result = await techLogin(ldapId.toLowerCase().trim());
      setTechInfo(result.technician);
    } catch (error: any) {
      if (!showPasswordField && error.message && error.message.includes("not found")) {
        setShowPasswordField(true);
        toast({
          title: "Not a Technician",
          description: "Not found as technician. If you're an admin, enter your password below.",
        });
      } else {
        toast({
          title: "Login Failed",
          description: error.message || "ID not found or inactive",
          variant: "destructive",
        });
      }
    } finally {
      setIsLoading(false);
    }
  }

  function handleTechContinue() {
    if (phoneChanged && newPhone.trim()) {
      localStorage.setItem("vrs_phone_override", newPhone.trim());
    } else {
      localStorage.removeItem("vrs_phone_override");
    }
    setLocation("/tech");
  }

  function maskPhone(phone: string | null): string {
    if (!phone || phone.length < 4) return "***-****";
    return "***-***-" + phone.slice(-4);
  }

  if (techInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="w-full max-w-sm">
          <div className="text-center mb-6">
            <img src={searsLogo} alt="Sears Home Services" className="h-10 mx-auto mb-3" data-testid="img-logo" />
            <h1 className="text-2xl font-bold" data-testid="text-welcome-title">
              Welcome, {techInfo.name || techInfo.ldapId}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">Field Technician</p>
          </div>
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">LDAP ID</span>
                  <span className="text-sm font-medium" data-testid="text-tech-ldap">{techInfo.ldapId}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">District</span>
                  <span className="text-sm font-medium" data-testid="text-tech-district">{techInfo.district || "\u2014"}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">Phone on File</span>
                  <span className="text-sm font-medium" data-testid="text-tech-phone">{maskPhone(techInfo.phone)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="phone-changed"
                  checked={phoneChanged}
                  onCheckedChange={(checked) => setPhoneChanged(!!checked)}
                  data-testid="checkbox-phone-changed"
                />
                <Label htmlFor="phone-changed" className="text-sm">My phone number has changed</Label>
              </div>
              {phoneChanged && (
                <div className="space-y-2">
                  <Label htmlFor="new-phone">New Phone Number</Label>
                  <Input
                    id="new-phone"
                    type="tel"
                    placeholder="(555) 555-0147"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    data-testid="input-new-phone"
                  />
                </div>
              )}
              <Button
                className="w-full h-11 text-base"
                onClick={handleTechContinue}
                data-testid="button-tech-continue"
              >
                Continue to Dashboard
              </Button>
            </CardContent>
          </Card>
          <div className="text-center mt-4">
            <button
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setLocation("/agent/login")}
              data-testid="link-agent-login"
            >
              VRS Agent? Login here
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <img src={searsLogo} alt="Sears Home Services" className="h-10 mx-auto mb-3" data-testid="img-logo" />
          <h1 className="text-2xl font-bold" data-testid="text-login-title">VRS Express</h1>
          <p className="text-sm text-muted-foreground mt-1">Field Technician</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Technician Sign In</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleTechSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ldap-id">LDAP ID</Label>
                <Input
                  id="ldap-id"
                  type="text"
                  placeholder=""
                  value={ldapId}
                  onChange={(e) => setLdapId(e.target.value)}
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="h-11 text-base"
                  data-testid="input-ldap-id"
                />
                <p className="text-xs text-muted-foreground">Enter your LDAP ID to sign in. No password required.</p>
              </div>
              {showPasswordField && (
                <div className="space-y-2">
                  <Label htmlFor="admin-password">Password</Label>
                  <PasswordInput
                    id="admin-password"
                    placeholder="Enter admin password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    required
                    data-testid="input-tech-admin-password"
                  />
                  <p className="text-xs text-muted-foreground">Not found as technician. If you're an admin, enter your password above.</p>
                </div>
              )}
              <Button type="submit" className="w-full h-11 text-base" disabled={isLoading || !ldapId.trim() || (showPasswordField && !adminPassword)} data-testid="button-tech-login">
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Looking up...
                  </>
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="text-center mt-4">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setLocation("/agent/login")}
            data-testid="link-agent-login"
          >
            VRS Agent? Login here
          </button>
        </div>
      </div>
    </div>
  );
}
