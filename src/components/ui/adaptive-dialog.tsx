/* Adaptive dialog: an iOS-style bottom sheet (vaul drawer with grabber) on phones,
 * a centered dialog on desktop. Exports mirror ui/dialog so call sites only swap
 * the import path. */
import * as React from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Dialog as BaseDialog,
  DialogContent as BaseDialogContent,
  DialogDescription as BaseDialogDescription,
  DialogFooter as BaseDialogFooter,
  DialogHeader as BaseDialogHeader,
  DialogTitle as BaseDialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

const MobileCtx = React.createContext(false);

interface RootProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

export function Dialog({ open, onOpenChange, children }: RootProps) {
  const isMobile = useIsMobile();
  return (
    <MobileCtx.Provider value={isMobile}>
      {isMobile ? (
        <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
          {children}
        </Drawer>
      ) : (
        <BaseDialog open={open} onOpenChange={onOpenChange}>
          {children}
        </BaseDialog>
      )}
    </MobileCtx.Provider>
  );
}

export const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => {
  const isMobile = React.useContext(MobileCtx);
  if (isMobile) {
    return (
      <DrawerContent
        ref={ref}
        {...props}
        className={cn("rounded-t-2xl max-h-[92dvh]", className)}
      >
        <div
          className="overflow-y-auto overscroll-contain px-4 pb-4 pt-1"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
        >
          {children}
        </div>
      </DrawerContent>
    );
  }
  return (
    <BaseDialogContent ref={ref} className={className} {...props}>
      {children}
    </BaseDialogContent>
  );
});
DialogContent.displayName = "AdaptiveDialogContent";

export function DialogHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = React.useContext(MobileCtx);
  return isMobile
    ? <DrawerHeader {...props} className={cn("px-0 text-left", props.className)} />
    : <BaseDialogHeader {...props} />;
}

export function DialogTitle(props: React.HTMLAttributes<HTMLHeadingElement>) {
  const isMobile = React.useContext(MobileCtx);
  return isMobile ? <DrawerTitle {...props} /> : <BaseDialogTitle {...props} />;
}

export function DialogDescription(props: React.HTMLAttributes<HTMLParagraphElement>) {
  const isMobile = React.useContext(MobileCtx);
  return isMobile ? <DrawerDescription {...props} /> : <BaseDialogDescription {...props} />;
}

export function DialogFooter(props: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = React.useContext(MobileCtx);
  return isMobile
    ? <DrawerFooter {...props} className={cn("px-0 pb-0 gap-2", props.className)} />
    : <BaseDialogFooter {...props} />;
}
