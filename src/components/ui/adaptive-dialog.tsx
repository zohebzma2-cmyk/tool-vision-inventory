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
    // Note: `className` here is intentionally NOT forwarded to the drawer — call sites pass
    // desktop-dialog sizing (max-w, max-h, overflow-y-auto) that would fight the sheet's own
    // layout and create a nested scroll. The sheet is one flex column: fixed grabber, a single
    // scrolling body, and a footer pinned inside it.
    return (
      <DrawerContent ref={ref} {...props} className="rounded-t-2xl max-h-[92dvh] flex flex-col">
        {/* data-vaul-no-drag stops the drawer's drag-to-dismiss from stealing the scroll
            gesture, so tall multi-step flows scroll reliably and their pinned footer stays
            reachable — the earlier "can't complete add-a-storage-location on a phone" bug. */}
        <div
          data-vaul-no-drag
          className="flex-1 overflow-y-auto overscroll-contain px-4 pt-1 [-webkit-overflow-scrolling:touch]"
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
  // On mobile the footer sticks to the bottom of the scroll area so the primary action
  // (Next / Create / Save) is always visible and tappable, never scrolled off-screen.
  return isMobile
    ? (
      <DrawerFooter
        {...props}
        className={cn(
          "sticky bottom-0 z-10 -mx-4 mt-2 gap-2 border-t border-border bg-background/95 px-4 pt-3 backdrop-blur",
          props.className,
        )}
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)", ...props.style }}
      />
    )
    : <BaseDialogFooter {...props} />;
}
