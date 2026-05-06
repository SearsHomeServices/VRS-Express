import { useState, lazy, Suspense } from "react";
import { Switch, Route, Redirect } from "wouter";
import { queryClient, apiRequest } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ThemeProvider } from "@/components/theme-provider";
import BottomNav from "@/components/bottom-nav";
import LandingPage from "@/pages/landing";
import TechLoginPage from "@/pages/tech-login";
import AgentLoginPage from "@/pages/agent-login";
import AdminLoginPage from "@/pages/admin-login";
import TechHomePage from "@/pages/tech-home";
import NotFound from "@/pages/not-found";
import InstallPrompt from "@/components/install-prompt";
import OnboardingWizard from "@/components/onboarding-wizard";
import WhatsNewModal from "@/components/whats-new-modal";

const TechSubmitPage = lazy(() => import("@/pages/tech-submit"));
const TechHistoryPage = lazy(() => import("@/pages/tech-history"));
const SubmissionDetailPage = lazy(() => import("@/pages/submission-detail"));
const AgentDashboard = lazy(() => import("@/pages/agent-dashboard"));
const AdminDashboard = lazy(() => import("@/pages/admin-dashboard"));
const AdminCommunicationsPage = lazy(() => import("@/pages/admin-communications"));
const HelpCenterPage = lazy(() => import("@/pages/help-center"));
const TechResubmitPage = lazy(() => import("@/pages/tech-resubmit"));
const TechFeedbackPage = lazy(() => import("@/pages/tech-feedback"));

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

function TechRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Redirect to="/tech/login" />;
  if (user.role === "vrs_agent") return <Redirect to="/agent/dashboard" />;
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Component />
      <BottomNav />
    </Suspense>
  );
}

function AgentRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Redirect to="/agent/login" />;
  if (user.mustChangePassword) return <Redirect to="/agent/login" />;
  if (user.role === "technician") return <Redirect to="/tech" />;
  return <Suspense fallback={<LoadingScreen />}><AgentDashboard /></Suspense>;
}

function AdminRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Redirect to="/admin/login" />;
  if (user.mustChangePassword) return <Redirect to="/admin/login" />;
  if (user.role === "technician") return <Redirect to="/tech" />;
  if (user.role === "vrs_agent") return <Redirect to="/agent/dashboard" />;
  return <Suspense fallback={<LoadingScreen />}><AdminDashboard /></Suspense>;
}

function AdminCommunicationsRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Redirect to="/admin/login" />;
  if (user.mustChangePassword) return <Redirect to="/admin/login" />;
  if (user.role === "technician") return <Redirect to="/tech" />;
  if (user.role === "vrs_agent") return <Redirect to="/agent/dashboard" />;
  return <Suspense fallback={<LoadingScreen />}><AdminCommunicationsPage /></Suspense>;
}

// Tyler 2026-04-30: Help center role gating.
// Each role lands on its own help route so the help-center page can read
// the role via useAuth and filter content appropriately. /help becomes a
// smart redirect rather than a hardcoded jump to /tech/help — the prior
// behavior was bouncing agents/admins off the page entirely when they
// clicked the "Help Center" button in their sidebar footer.
function HelpRedirect() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Redirect to="/" />;
  if (user.role === "vrs_agent") return <Redirect to="/agent/help" />;
  if (user.role === "admin" || user.role === "super_admin") return <Redirect to="/admin/help" />;
  return <Redirect to="/tech/help" />;
}

function AgentHelpRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Redirect to="/agent/login" />;
  if (user.mustChangePassword) return <Redirect to="/agent/login" />;
  if (user.role === "technician") return <Redirect to="/tech/help" />;
  return <Suspense fallback={<LoadingScreen />}><HelpCenterPage /></Suspense>;
}

function AdminHelpRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Redirect to="/admin/login" />;
  if (user.mustChangePassword) return <Redirect to="/admin/login" />;
  if (user.role === "technician") return <Redirect to="/tech/help" />;
  if (user.role === "vrs_agent") return <Redirect to="/agent/help" />;
  return <Suspense fallback={<LoadingScreen />}><HelpCenterPage /></Suspense>;
}

function LandingRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (user) {
    if (user.role === "admin" || user.role === "super_admin") return <Redirect to="/admin/dashboard" />;
    if (user.role === "vrs_agent") return <Redirect to="/agent/dashboard" />;
    return <Redirect to="/tech" />;
  }
  return <LandingPage />;
}

function OnboardingManager() {
  const { user, refreshUser } = useAuth();
  const [dismissed, setDismissed] = useState(() => {
    return sessionStorage.getItem("vrs_onboarding_dismissed") === "true";
  });

  if (!user) return null;

  const appVersion = import.meta.env.VITE_APP_VERSION || "1.0.0";
  const showOnboarding = !dismissed && user.firstLogin === true;
  const showWhatsNew = !dismissed && !showOnboarding && user.lastSeenVersion !== appVersion;

  const handleWizardComplete = async () => {
    setDismissed(true);
    sessionStorage.setItem("vrs_onboarding_dismissed", "true");
    try {
      await apiRequest("PATCH", "/api/users/me", {
        firstLogin: false,
        lastSeenVersion: appVersion,
      });
    } catch (e) {
      console.error("Failed to dismiss onboarding:", e);
    }
    refreshUser();
  };

  const handleWhatsNewDismiss = async () => {
    setDismissed(true);
    sessionStorage.setItem("vrs_onboarding_dismissed", "true");
    try {
      await apiRequest("PATCH", "/api/users/me", {
        lastSeenVersion: appVersion,
      });
    } catch (e) {
      console.error("Failed to dismiss what's new:", e);
    }
    refreshUser();
  };

  return (
    <div data-testid="onboarding-manager">
      <OnboardingWizard
        role={user.role as "technician" | "vrs_agent" | "admin" | "super_admin"}
        open={showOnboarding}
        onComplete={handleWizardComplete}
      />
      <WhatsNewModal
        open={showWhatsNew}
        onDismiss={handleWhatsNewDismiss}
        version={appVersion}
        role={user.role}
      />
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingRoute} />
      <Route path="/tech/login" component={TechLoginPage} />
      <Route path="/agent/login" component={AgentLoginPage} />
      <Route path="/admin/login" component={AdminLoginPage} />
      <Route path="/tech">
        {() => <TechRoute component={TechHomePage} />}
      </Route>
      <Route path="/tech/submit">
        {() => <TechRoute component={TechSubmitPage} />}
      </Route>
      <Route path="/tech/history">
        {() => <TechRoute component={TechHistoryPage} />}
      </Route>
      <Route path="/tech/submissions/:id">
        {() => <TechRoute component={SubmissionDetailPage} />}
      </Route>
      <Route path="/tech/resubmit/:id">
        {() => <TechRoute component={TechResubmitPage} />}
      </Route>
      <Route path="/tech/feedback">
        {() => <TechRoute component={TechFeedbackPage} />}
      </Route>
      <Route path="/agent/dashboard" component={AgentRoute} />
      <Route path="/admin/dashboard" component={AdminRoute} />
      <Route path="/admin/communications" component={AdminCommunicationsRoute} />
      <Route path="/tech/help">
        {() => <TechRoute component={HelpCenterPage} />}
      </Route>
      <Route path="/agent/help" component={AgentHelpRoute} />
      <Route path="/admin/help" component={AdminHelpRoute} />
      <Route path="/login">{() => <Redirect to="/" />}</Route>
      <Route path="/submit">{() => <Redirect to="/tech/submit" />}</Route>
      <Route path="/history">{() => <Redirect to="/tech/history" />}</Route>
      <Route path="/submissions/:id">
        {(params: { id: string }) => <Redirect to={`/tech/submissions/${params.id}`} />}
      </Route>
      <Route path="/help" component={HelpRedirect} />
      <Route path="/agent">{() => <Redirect to="/agent/dashboard" />}</Route>
      <Route path="/admin">{() => <Redirect to="/admin/dashboard" />}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <Toaster />
            <Router />
            <OnboardingManager />
            <InstallPrompt />
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
