export function Dynamic({ t }: { t: (k: string) => string }) {
  return (
    <p lang="ar" className="tracking-wide">{t("greeting")}</p>
  );
}
