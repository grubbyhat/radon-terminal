import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/rt-logo-transparent.png`;
  return {
    title: "RT — Radon Terminal",
    description: "Live Solana market-structure reconstruction from a Helius transaction stream.",
    icons: {
      icon: "/rt-logo-transparent.png",
      shortcut: "/rt-logo-transparent.png",
      apple: "/rt-logo-transparent.png",
    },
    openGraph: {
      title: "RT — Radon Terminal",
      description: "Live Solana market-structure reconstruction from a Helius transaction stream.",
      images: [{ url: imageUrl, width: 1024, height: 1024, alt: "RT — Radon Terminal" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "RT — Radon Terminal",
      description: "Live Solana market-structure reconstruction from a Helius transaction stream.",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geist.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
