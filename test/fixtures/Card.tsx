export function ArabicCard() {
  return (
    <div className="tracking-wide leading-tight text-sm uppercase" style={{ fontFamily: "Inter" }}>
      <p className="tracking-tighter">مرحبا بالعالم</p>
    </div>
  );
}

export function LatinCard() {
  // Same styling, no Arabic → kashida stays silent (typography is fine for Latin).
  return <div className="tracking-wide leading-tight text-sm uppercase">Hello world</div>;
}
