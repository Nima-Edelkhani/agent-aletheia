export function SectionMarker({ n, label }: { n: string; label: string }) {
  return (
    <div className="marker">
      <span className="marker__number">{n}</span>
      <span className="marker__label">{label}</span>
      <span className="marker__rule" />
    </div>
  );
}
