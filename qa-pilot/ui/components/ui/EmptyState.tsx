import { Icon, type IconName } from "./Icon";
import { Wallpaper } from "./Wallpaper";

/**
 * The empty state carries one of the Raycast wallpapers as a dim wash behind it, masked
 * to fade out before it reaches the copy. It is the one place in the app with room for
 * atmosphere, and a bare centred paragraph on a near-black canvas looks broken rather
 * than empty.
 */
export function EmptyState({
  title, body, action, icon = "flask", wallpaper = true,
}: { title: string; body: string; action?: React.ReactNode; icon?: IconName; wallpaper?: boolean }) {
  return (
    <div className="relative isolate flex flex-col items-center gap-3 overflow-hidden px-6 py-20 text-center">
      {wallpaper && <Wallpaper name="loupe" className="h-full opacity-40 [mask-image:radial-gradient(90%_80%_at_50%_35%,#000_0%,transparent_75%)]" />}
      <span className="flex size-11 items-center justify-center rounded-box border border-line bg-inset text-muted">
        <Icon name={icon} size={19} />
      </span>
      <h3 className="text-[15px] font-medium tracking-[0.2px] text-fg">{title}</h3>
      <p className="max-w-sm text-[13px] leading-relaxed text-muted">{body}</p>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
