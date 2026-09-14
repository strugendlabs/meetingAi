import type { Metadata } from "next";
import { Hanken_Grotesk, Newsreader, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
});

const spline = Spline_Sans_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-spline",
});

export const metadata: Metadata = {
  title: {
    default: "MeetingAI — your meetings, your models",
    template: "%s — MeetingAI",
  },
  description:
    "Open-source meeting notes with local storage. Bring your own Gemini API key or run Whisper and Ollama locally. MIT licensed.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body
        className={`${hanken.variable} ${newsreader.variable} ${spline.variable} antialiased`}
      >
        <Nav />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
