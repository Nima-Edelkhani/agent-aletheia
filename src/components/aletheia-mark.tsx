import type { SVGProps } from "react";

export function AletheiaMark(props: SVGProps<SVGSVGElement>) {
  const { className, "aria-label": ariaLabel, ...rest } = props;
  const label = ariaLabel ?? "Aletheia";
  return (
    <svg
      viewBox="0 0 252 116"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={label}
      className={className}
      {...rest}
    >
      <rect width="0" height="0" fill="transparent" />
      <circle cx="57.5" cy="57.5" r="57.5" />
      <rect x="137" y="1" width="115" height="115" />
    </svg>
  );
}
