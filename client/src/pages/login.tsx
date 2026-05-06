import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Check, X } from "lucide-react";
import searsLogo from "@assets/sears-home-services-logo-brands_1770949137899.png";

export default function LoginPage() {
  const [activeTab, setActiveTab] = useState<"technician" | "agent">("technician");
  const [agentLdapId, setAgentLdapId] = useState("");
  const [password, setPassword] = useState("");
  const [ldapId, setLdapId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [techInfo, setTechInfo] = useState<any>(null);
  const [phoneChanged, setPhoneChanged] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [changePasswordUser, setChangePasswordUser] = useState<any>(null);
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [changePwLoading, setChangePwLoading] = useState(false);
  const { login, techLogin } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  async function handleAgentSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    try {
      const user = await login(agentLdapId.trim(), password);
      if (user.mustChangePassword) {
        setMustChangePassword(true);
        setChangePasswordUser(user);
      } else {
        if (user.role === "admin" || user.role === "super_admin") {
          setLocation("/admin");
        } else if (user.role === "vrs_agent") {
          setLocation("/agent");
        } else {
          setLocation("/");
        }
      }
    } catch (error: any) {
      toast({
        title: "Login Failed",
        description: error.message || "Invalid credentials",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }

  const pwRequirements = [
    { label: "Min 8 characters", met: newPw.length >= 8 },
    { label: "1 uppercase letter", met: /[A-Z]/.test(newPw) },
    { label: "1 lowercase letter", met: /[a-z]/.test(newPw) },
    { label: "1 number", met: /\d/.test(newPw) },
    { label: "1 special character (!@#$%^&*)", met: /[!@#$%^&*]/.test(newPw) },
  ];

  const allRequirementsMet = pwRequirements.every((r) => r.met);
  const passwordsMatch = newPw === confirmPw && confirmPw.length > 0;

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!allRequirementsMet || !passwordsMatch) return;
    setChangePwLoading(true);
    try {
      const token = localStorage.getItem("vrs_token");
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword: password, newPassword: newPw }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to change password");
      }
      toast({ title: "Password Changed", description: "Your password has been updated successfully." });
      if (changePasswordUser?.role === "admin" || changePasswordUser?.role === "super_admin") {
        setLocation("/admin");
      } else if (changePasswordUser?.role === "vrs_agent") {
        setLocation("/agent");
      } else {
        setLocation("/");
      }
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setChangePwLoading(false);
    }
  }

  async function handleTechSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    try {
      const result = await techLogin(ldapId.toLowerCase().trim());
      setTechInfo(result.technician);
    } catch (error: any) {
      toast({
        title: "Login Failed",
        description: error.message || "ID not found or inactive",
        variant: "destructive",
      });
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
    setLocation("/");
  }

  function maskPhone(phone: string | null): string {
    if (!phone || phone.length < 4) return "***-****";
    return "***-***-" + phone.slice(-4);
  }

  if (mustChangePassword && changePasswordUser) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="w-full max-w-sm">
          <div className="text-center mb-6">
            <img src={searsLogo} alt="Sears Home Services" className="h-10 mx-auto mb-3" data-testid="img-logo-change-pw" />
            <h1 className="text-2xl font-bold" data-testid="text-change-pw-title">
              Change Password
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Welcome, {changePasswordUser.name}
            </p>
          </div>
          <Card>
            <CardContent className="p-4">
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="new-password">New Password</Label>
                  <PasswordInput
                    id="new-password"
                    placeholder="Enter new password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    required
                    data-testid="input-new-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <PasswordInput
                    id="confirm-password"
                    placeholder="Confirm new password"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    required
                    data-testid="input-confirm-password"
                  />
                  {confirmPw.length > 0 && !passwordsMatch && (
                    <p className="text-xs text-red-600 dark:text-red-400" data-testid="text-pw-mismatch">Passwords do not match</p>
                  )}
                </div>
                <div className="space-y-1.5" data-testid="pw-requirements">
                  <p className="text-xs font-medium text-muted-foreground">Password Requirements:</p>
                  {pwRequirements.map((req) => (
                    <div key={req.label} className="flex items-center gap-2">
                      {req.met ? (
                        <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                      ) : (
                        <X className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                      <span className={`text-xs ${req.met ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
                        {req.label}
                      </span>
                    </div>
                  ))}
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={changePwLoading || !allRequirementsMet || !passwordsMatch}
                  data-testid="button-change-password"
                >
                  {changePwLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Changing...
                    </>
                  ) : (
                    "Change Password"
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
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
                  <span className="text-sm font-medium" data-testid="text-tech-district">{techInfo.district || "—"}</span>
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
                className="w-full"
                onClick={handleTechContinue}
                data-testid="button-tech-continue"
              >
                Continue to Dashboard
              </Button>
            </CardContent>
          </Card>
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
          <p className="text-sm text-muted-foreground mt-1">Sears Home Services</p>
        </div>

        <div className="flex mb-4 rounded-md border overflow-hidden">
          <button
            type="button"
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "technician"
                ? "bg-primary text-primary-foreground"
                : "hover-elevate"
            }`}
            onClick={() => setActiveTab("technician")}
            data-testid="tab-technician-login"
          >
            Field Technician
          </button>
          <button
            type="button"
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "agent"
                ? "bg-primary text-primary-foreground"
                : "hover-elevate"
            }`}
            onClick={() => setActiveTab("agent")}
            data-testid="tab-agent-login"
          >
            VRS Agent / Admin
          </button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {activeTab === "technician" ? "Technician Sign In" : "Agent / Admin Sign In"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeTab === "technician" ? (
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
                    data-testid="input-ldap-id"
                  />
                  <p className="text-xs text-muted-foreground">Enter your LDAP ID to sign in. No password required.</p>
                </div>
                <Button type="submit" className="w-full" disabled={isLoading || !ldapId.trim()} data-testid="button-tech-login">
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
            ) : (
              <form onSubmit={handleAgentSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="agent-ldap-id">LDAP ID</Label>
                  <Input
                    id="agent-ldap-id"
                    type="text"
                    placeholder=""
                    value={agentLdapId}
                    onChange={(e) => setAgentLdapId(e.target.value)}
                    required
                    autoCapitalize="none"
                    autoCorrect="off"
                    data-testid="input-agent-ldap-id"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <PasswordInput
                    id="password"
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    data-testid="input-password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={isLoading} data-testid="button-login">
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Signing in...
                    </>
                  ) : (
                    "Sign In"
                  )}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
