"use client";;
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { following, land, pinned, pinTop, room, settle } from "@/lib/scroll-pin";

const REDUCE = "(prefers-reduced-motion: reduce)";
const onMotionPref = (change) => {
  const query = matchMedia(REDUCE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
const useReducedMotion = () => useSyncExternalStore(onMotionPref, () => matchMedia(REDUCE).matches);

export const Conversation = ({
  className,
  ...props
}) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize={useReducedMotion() ? "instant" : "smooth"}
    role="log"
    {...props} />
);

// Holds the user message `id` near the top of the view while its reply fills
// in below it, then hands back to following once the reply outgrows the view.
// The first id a transcript sees is the chat being opened, and every later one
// is a send. The message's row carries `data-turn={id}`.
export function useTurnPin(id) {
  const context = useStickToBottomContext();
  const { scrollRef, contentRef, state, scrollToBottom, stopScroll } = context;
  const reduced = useReducedMotion();
  const mode = useRef(following);
  const anchorId = useRef(id);
  anchorId.current = id;
  const opened = useRef(false);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const anchor = anchorId.current && content?.querySelector(`[data-turn="${CSS.escape(anchorId.current)}"]`);
    if (!anchor) return null;
    // offsetTop, not the bounding box: a row that just landed is still sliding
    // in on a transform, and the pin must not chase the slide.
    return {
      anchorTop: anchor.offsetTop - content.offsetTop,
      natural: el.scrollHeight - (parseFloat(el.style.paddingBottom) || 0),
      viewport: el.clientHeight,
    };
  }, [scrollRef, contentRef]);

  // The room is padding on the scroller, outside the content box the library
  // watches, so it never reads as the transcript growing. The extra pixel is
  // because the library takes one pixel short of the end as the end.
  const fit = useCallback((geo) => {
    mode.current = settle(mode.current, geo);
    const extra = mode.current.kind === "pinned" ? room(geo) : 0;
    scrollRef.current.style.paddingBottom = extra > 0 ? `${extra + 1}px` : "";
  }, [scrollRef]);

  useLayoutEffect(() => {
    context.targetScrollTop = (end) => {
      if (mode.current.kind !== "pinned") return end;
      const geo = measure();
      return geo ? pinTop(geo.anchorTop) : end;
    };
    const el = scrollRef.current;
    return () => {
      context.targetScrollTop = null;
      mode.current = following;
      if (el) el.style.paddingBottom = "";
    };
    // The setter writes a ref shared by every render's context object.
  }, [measure, scrollRef]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (mode.current.kind !== "pinned") return;
      const geo = measure();
      fit(geo);
      // A row shrinking (the thinking line leaving, say) clamps the scroll
      // before the room grows back, and the library only scrolls on growth.
      if (mode.current.kind === "pinned" && state.isAtBottom) state.scrollTop = pinTop(geo.anchorTop);
    });
    observer.observe(contentRef.current);
    observer.observe(scrollRef.current, { box: "border-box" });
    return () => observer.disconnect();
  }, [contentRef, scrollRef, measure, fit, state]);

  useLayoutEffect(() => {
    if (!id) return;
    const geo = measure();
    if (!opened.current) {
      opened.current = true;
      const landing = land(id, geo);
      mode.current = landing.mode;
      fit(geo);
      if (geo) state.scrollTop = pinTop(geo.anchorTop);
      if (landing.free) stopScroll();
      else scrollToBottom("instant");
      return;
    }
    mode.current = pinned(id);
    fit(geo);
    scrollToBottom(reduced ? "instant" : undefined);
    // Only a new message moves the view; a change of motion preference does not.
  }, [id]);
}

export const ConversationContent = ({
  className,
  ...props
}) => (
  <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", className)} {...props} />
);

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}>
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export const ConversationScrollButton = ({
  className,
  ...props
}) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (!isAtBottom && (<Button
    className={cn(
      "conn-rise absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
      className
    )}
    onClick={handleScrollToBottom}
    size="icon"
    type="button"
    variant="outline"
    {...props}>
    <ArrowDownIcon className="size-4" />
  </Button>));
};
