import { CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

const ICONS = {
  default: { Icon: Info, cls: "text-primary" },
  success: { Icon: CheckCircle2, cls: "text-success" },
  warning: { Icon: AlertTriangle, cls: "text-warning" },
  destructive: { Icon: XCircle, cls: "text-white" },
} as const

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const { Icon, cls } = ICONS[(variant as keyof typeof ICONS) ?? "default"] ?? ICONS.default
        return (
          <Toast key={id} variant={variant} {...props}>
            <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${cls}`} aria-hidden />
            <div className="grid gap-0.5 flex-1 min-w-0 pr-4">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
