import { cva, type VariantProps } from "class-variance-authority";
import { SatelliteLoader, type SatelliteLoaderProps } from "~/components/SatelliteLoader";
import { cn } from "~/lib/utils";

// No default size: inside a Button the parent's svg rule sizes the glyph.
const spinnerVariants = cva("", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
    tone: {
      current: "",
      muted: "text-muted-foreground",
    },
  },
  defaultVariants: { tone: "current" },
});

function Spinner({
  className,
  size,
  tone,
  ...props
}: Omit<SatelliteLoaderProps, "loading" | "size" | "role" | "aria-label"> &
  VariantProps<typeof spinnerVariants>) {
  return (
    <SatelliteLoader
      loading
      aria-label="Loading"
      className={cn(spinnerVariants({ size, tone }), className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
