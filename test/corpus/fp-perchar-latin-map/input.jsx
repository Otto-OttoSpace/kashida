export function Letters() {
  return (
    <p>
      {[...'Hello'].map((c, i) => <span key={i}>{c}</span>)}
    </p>
  );
}
