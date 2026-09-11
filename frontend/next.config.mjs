/** @type {import('next').NextConfig} */
// 1A.1 — no rewrites/proxying to any Infrakinetic or management-API origin
// yet. NEXT_PUBLIC_* variables may never hold a secret or a privileged-API
// origin (master plan §7.1 item 5) — none are declared yet, by design.
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
