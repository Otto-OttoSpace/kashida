export function Letters({ text }) {
  return (
    <h1 dir="rtl">
      {text.split('').map((ch, i) => <span key={i} className="char">{ch}</span>)}
    </h1>
  );
}
