import * as React from "react"
import { Eye, EyeOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

type PasswordInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  "data-testid"?: string
}

const PasswordInput = React.forwardRef<
  HTMLInputElement,
  PasswordInputProps
>(({ className, "data-testid": testId, ...props }, ref) => {
  const [visible, setVisible] = React.useState(false)

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 pr-9 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        data-testid={testId}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0 top-0 h-9 w-9 px-2 hover:bg-transparent"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        data-testid={testId ? `${testId}-toggle` : "button-toggle-password"}
      >
        {visible ? (
          <EyeOff className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Eye className="h-4 w-4 text-muted-foreground" />
        )}
      </Button>
    </div>
  )
})
PasswordInput.displayName = "PasswordInput"

export { PasswordInput }
