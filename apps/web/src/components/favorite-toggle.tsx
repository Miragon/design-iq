/**
 * The favorite toggle (#213) — a star, but the word is "Favorite": next to
 * GitHub-style rows, "Star" would read like a GitHub star, which this is not
 * (a designIQ favorite is per person and never leaves the platform). A
 * `<button aria-pressed>`, always a SIBLING of the repository's link — never
 * inside it — so one click toggles without opening the repository. On, it is
 * a FILLED star in the CI blue: a favorite is a personal selection, and
 * selection is blue (5.5:1 on the card); the fill, not the hue, tells on from
 * off.
 */
import { Button } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { Star } from "lucide-react";

import { useToggleFavorite } from "@/lib/queries";

export function FavoriteToggle({
  fullName,
  favorite,
  onToggled,
  className,
}: {
  fullName: string;
  favorite: boolean;
  /** after the optimistic flip — the start page keeps an un-favorited row in view */
  onToggled?: (favorite: boolean) => void;
  className?: string;
}) {
  const toggle = useToggleFavorite();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-8 shrink-0", className)}
      aria-pressed={favorite}
      aria-label={`Favorite ${fullName}`}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      onClick={() => {
        toggle(fullName, !favorite);
        onToggled?.(!favorite);
      }}
    >
      <Star className={cn("transition-colors", favorite ? "fill-primary text-primary" : "text-muted-foreground")} />
    </Button>
  );
}
