export const metadata = {
  title: "PolyNovea Platform Governance",
  description: "Root operator plane for Infrakinetic.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
