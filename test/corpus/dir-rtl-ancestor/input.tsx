export function Nested({ name }: { name: string }) {
  return (
    <div dir="rtl">
      <span className="tracking-widest">{name}</span>
    </div>
  );
}
