import { useState } from "react";
import { Link } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Search, LifeBuoy, ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/auth";

// Tyler 2026-04-30: Map each role to its "home" so the back button has
// somewhere meaningful to send the user. The help center is a leaf page
// reached from sidebars/footers and previously had no way back.
function getDashboardPath(role: string | undefined): string {
  if (role === "admin" || role === "super_admin") return "/admin/dashboard";
  if (role === "vrs_agent") return "/agent/dashboard";
  return "/tech"; // technicians + any unknown role fall back to tech home
}

// Tyler 2026-04-30: Audience tagging for help items.
//   - "tech": only relevant to field technicians (LDAP login, photo upload,
//     PWA install, etc). Hidden from agents/admins ONLY if Tyler later
//     decides he wants that — current rule is agents/admins see everything.
//   - "agent_admin": agent/admin-portal content. Hidden from techs.
//   - "all": general orientation, applies to every role.
// Filter rule: technicians see {tech, all}. Agents/admins see everything.
// Default audience when omitted is "tech" (the historical content origin).
type Audience = "tech" | "agent_admin" | "all";

interface HelpItem {
  title: string;
  content: string;
  audience?: Audience;
}

const gettingStartedItems: HelpItem[] = [
  {
    title: "What is VRS Express?",
    audience: "all",
    content:
      "VRS Express is a digital authorization platform for Sears Home Services that replaces the traditional call-in process. It allows you to submit authorization requests directly from your mobile device, track their status in real time, and receive authorization codes via SMS once approved.",
  },
  {
    title: "How do I log in?",
    content:
      "From the home screen, tap \"Field Technician\" to access the technician login. Enter your LDAP ID and password. If this is your first time logging in, you may be guided through a short onboarding wizard that walks you through the key features of the app. You can restart this wizard at any time using the reset button on the home screen.",
  },
  {
    title: "Your Home Screen",
    content:
      "After logging in, your home screen shows three stat cards — Pending, Approved, and Rejected — so you can see your submission counts at a glance. Below that is a \"New Submission\" button, followed by your most recent submissions. Use \"View All\" to see your full submission history.",
  },
];

const howToGuidesItems: HelpItem[] = [
  {
    title: "Submitting an Authorization Request",
    content:
      "Tap \"New Submission\" from your home screen. Select the request type — \"Authorization\" for repair approvals or \"Infestation / Non-Accessible\" if you are unable to service due to pests, mold, or access issues. Enter your Service Order number (format: DDDD-SSSSSSSS), select the appliance type and warranty provider, and describe the issue in detail (minimum 20 characters). You can use the AI Enhance button to help clarify your description. Upload required photos of the issue and of the model/serial tag and TechHub estimate. You can optionally add a short video (max 30 seconds) or record a voice note (up to 2 minutes). Once everything is filled in, tap Submit.",
  },
  {
    title: "Understanding Submission Status",
    content:
      "Each of your submissions will show one of the following statuses. \"Pending\" (yellow) means your request is in the queue or being reviewed by an agent. \"Approved\" (green) means the request has been fully approved and your authorization code has been sent. \"Rejected\" (red) means the agent found an issue — check the rejection reason and resubmit with updated information. \"Closed — Not Covered\" means the repair was determined to not be covered under warranty, and no further resubmissions are allowed for that Service Order. \"Invalid\" means the submission had a fundamental issue such as wrong warranty type or duplicate entry.",
  },
  {
    title: "Receiving Authorization Codes",
    content:
      "Once your submission is fully approved, you will receive the authorization code (RGC code) via SMS to the phone number you provided on the submission. The code is also displayed on your submission detail page within the app. Tap any submission from your home screen or history to view its full details including the authorization code. Use this code to proceed with the authorized repair or parts order.",
  },
  {
    title: "Resubmitting After Rejection",
    content:
      "If your submission is rejected, you will receive an SMS explaining the specific reasons (for example, blurry photos or incomplete estimate). The SMS includes a direct link to resubmit. Tap the link to open a resubmission form that is pre-filled with your original details. Update the information or upload new photos that address the rejection reasons, then submit again. Note: you are limited to 3 resubmissions per ticket. If all three are rejected, you will need to call VRS directly for assistance.",
  },
  {
    title: "Which pathway do I use? (Authorization vs NLA vs TechHub)",
    content:
      "Use the table below to decide where to submit.\n\n• Sears Protect / PA / Cinch — Authorization: submit in VRS.\n• Sears Protect / PA / Cinch — NLA: submit in VRS.\n• American Home Shield — Authorization: submit in VRS.\n• American Home Shield — NLA: handle through TechHub. VRS does not process AHS NLA.\n• First American — Authorization: submit in VRS.\n• First American — NLA: handle through TechHub. VRS does not process FA NLA.\n• B2B: handle through TechHub / call process. VRS does not process B2B tickets.\n\nIf you are not sure which pathway applies, check the TechHub work order — the warranty type is listed there.",
  },
  {
    title: "Submitting an NLA Parts Request",
    content:
      "If TechHub shows a part as \"No Longer Available,\" tap \"New Submission\" and select \"Parts — No Longer Available (NLA)\" as the request type. This option is for Sears Protect, Sears PA, and Sears Home Warranty (Cinch) calls only. Enter the part number(s) that showed as unavailable, describe the issue, and upload photos of the failed part along with your model/serial tag. The VRS parts team will research sourcing options and notify you of the outcome.",
  },
];

const faqItems: HelpItem[] = [
  {
    title: "What happens after I submit a request?",
    content:
      "Your submission is automatically placed in the queue and routed to a VRS agent who specializes in the appliance type you selected. The agent will review your description, photos, and supporting evidence before making a decision. You can track the status of your submission from your home screen or submission history at any time.",
  },
  {
    title: "How long does approval usually take?",
    content:
      "Wait time depends on the warranty provider.\n\n• Sears Protect / Sears PA / Sears Home Warranty (Cinch): typically 2–15 minutes during business hours.\n• American Home Shield and First American: these require VRS to call the provider for approval, which can take significantly longer — sometimes over an hour depending on their hold times. Plan to stay at the site until you receive the decision text.\n• NLA Parts requests: researched by the VRS parts team — typical turnaround is 1–2 business days.\n\nIf your submission has been pending for an extended period, check with your supervisor.",
  },
  {
    title: "Can I edit a submission after sending it?",
    content:
      "No, submissions cannot be edited once they have been sent. If you need to make changes or provide additional information, you will need to create a new submission with the updated details and the same Service Order number.",
  },
  {
    title: "What if I don't receive my SMS notification?",
    content:
      "Verify that the phone number you entered on the submission form is correct and that your device has cellular reception. You can also check the submission detail page within the app — the authorization code and any status updates are displayed there. If you still have not received a notification, contact your supervisor for assistance.",
  },
  {
    title: "Which warranty providers are supported?",
    audience: "all",
    content:
      "VRS Express currently supports Sears Protect (Cinch), American Home Shield (AHS), and First American warranty submissions. Select the correct warranty provider during the submission process. Additional providers may be added in the future.",
  },
  {
    title: "What are the photo and video requirements?",
    content:
      "You must upload at least one issue photo (up to 15 allowed) showing the diagnosis or damage. You must also upload at least one model/serial tag and TechHub estimate photo (up to 5 allowed). Optionally, you can attach a video (max 50MB, max 30 seconds) and record or upload a voice note (max 10MB, up to 2 minutes). Clear, well-lit photos significantly speed up the review process.",
  },
  {
    title: "What if I get a \"Closed — Not Covered\" status?",
    content:
      "This means the VRS agent determined that the repair is not covered under the warranty. This is a final decision — you will not be able to submit another request for the same Service Order number. If you believe this decision was made in error, contact your supervisor to discuss next steps.",
  },
];

const troubleshootingItems: HelpItem[] = [
  {
    title: "I can't log in",
    content:
      "Make sure you are entering your correct LDAP ID and password on the technician login screen. If your account has not been set up yet, your supervisor or an administrator will need to create it. If you recently had your password reset, you may need to use the new credentials provided to you.",
  },
  {
    title: "My submission is stuck on Pending",
    content:
      "A submission may stay in Pending status if no agents are currently available to review it, or if the queue volume is high. If you submitted after business hours, your request will be processed once agents are back online the following business day. If your submission has been pending for an unusually long time, contact your supervisor.",
  },
  {
    title: "I didn't receive an authorization code",
    content:
      "Check that the phone number you provided on the submission form is correct and that your device can receive SMS messages. You can also open the submission detail page within the app — the authorization code will be displayed there once it has been sent. If the submission shows as \"Approved\" but you still have not received the code, contact your supervisor.",
  },
  {
    title: "The app won't install on my phone",
    content:
      "VRS Express is a Progressive Web App (PWA). To install it, open the app URL in Chrome (Android) or Safari (iOS). Tap the browser menu (three dots on Android or the share icon on iOS), then select \"Add to Home Screen.\" The app will appear as an icon on your device just like a regular app.",
  },
  {
    title: "My session expired and I was logged out",
    audience: "all",
    content:
      "For security, login sessions expire after 7 days. When this happens, you will be redirected to the login screen. Simply log in again with your credentials. This is normal and helps protect your account.",
  },
  {
    title: "Submitting after business hours",
    content:
      "If you need to submit an authorization request outside of business hours, you can still send it. Your submission will be placed in the queue and processed when agents are back online the next business day. After submitting, reach out through your normal scheduling channels to have the service call rescheduled so that the authorization can be obtained and processed before the follow-up appointment.",
  },
];

const tabSections = [
  { id: "getting-started", label: "Getting Started", testId: "tab-getting-started", items: gettingStartedItems },
  { id: "how-to", label: "How-To Guides", testId: "tab-how-to", items: howToGuidesItems },
  { id: "faqs", label: "FAQs", testId: "tab-faqs", items: faqItems },
  { id: "troubleshooting", label: "Troubleshooting", testId: "tab-troubleshooting", items: troubleshootingItems },
];

function isVisibleToRole(item: HelpItem, role: string | undefined): boolean {
  // Agents and admins see everything (Tyler 2026-04-30 directive).
  if (role && role !== "technician") return true;
  const audience = item.audience ?? "tech";
  return audience === "tech" || audience === "all";
}

function filterItems(items: HelpItem[], query: string): HelpItem[] {
  if (!query.trim()) return items;
  const lower = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(lower) ||
      item.content.toLowerCase().includes(lower)
  );
}

export default function HelpCenter() {
  const [searchQuery, setSearchQuery] = useState("");
  const { user } = useAuth();
  const role = user?.role;

  const filteredSections = tabSections.map((section) => {
    const visibleItems = section.items.filter((item) => isVisibleToRole(item, role));
    return {
      ...section,
      filteredItems: filterItems(visibleItems, searchQuery),
    };
  });

  const hasAnyResults = filteredSections.some((s) => s.filteredItems.length > 0);

  let globalIndex = 0;

  return (
    <div
      data-testid="help-center-page"
      className="flex-1 overflow-y-auto p-4 md:p-6"
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <Link href={getDashboardPath(role)}>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 gap-2"
            data-testid="button-back-to-dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Button>
        </Link>
        <div className="flex items-center gap-3">
          <LifeBuoy className="h-7 w-7 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Help Center</h1>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="input-help-search"
            placeholder="Search help articles..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {!hasAnyResults && searchQuery.trim() ? (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">
              No results found for "{searchQuery}"
            </CardContent>
          </Card>
        ) : (
          <Tabs defaultValue="getting-started">
            <TabsList className="flex flex-wrap gap-1 w-full">
              {filteredSections.map((section) => (
                <TabsTrigger
                  key={section.id}
                  value={section.id}
                  data-testid={section.testId}
                >
                  {section.label}
                </TabsTrigger>
              ))}
            </TabsList>

            {filteredSections.map((section) => {
              const startIndex = globalIndex;
              globalIndex += section.filteredItems.length;

              return (
                <TabsContent key={section.id} value={section.id}>
                  {section.filteredItems.length === 0 ? (
                    <Card>
                      <CardContent className="p-6 text-center text-muted-foreground">
                        No results found in {section.label}
                      </CardContent>
                    </Card>
                  ) : (
                    <Card>
                      <CardContent className="p-4 md:p-6">
                        <Accordion type="single" collapsible>
                          {section.filteredItems.map((item, idx) => (
                            <AccordionItem
                              key={idx}
                              value={`item-${startIndex + idx}`}
                              data-testid={`accordion-item-${startIndex + idx}`}
                            >
                              <AccordionTrigger>{item.title}</AccordionTrigger>
                              <AccordionContent>{item.content}</AccordionContent>
                            </AccordionItem>
                          ))}
                        </Accordion>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        )}
      </div>
    </div>
  );
}
