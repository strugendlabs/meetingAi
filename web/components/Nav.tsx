import Link from "next/link";

export function Wordmark() {
  return (
    <span className="text-[17px] font-semibold tracking-tight">
      Meeting
      <span className="font-display italic font-medium text-accent">AI</span>
    </span>
  );
}

const links = [
  { href: "/#providers", label: "Your AI" },
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#faq", label: "FAQ" },
];

export default function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-paper/85 backdrop-blur-md">
      <nav
        aria-label="Main"
        className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8"
      >
        <Link href="/" className="flex items-center" aria-label="MeetingAI home">
          <Wordmark />
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-[13.5px] text-inksoft transition-colors hover:text-ink"
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-5">
          <Link
            href="/privacy"
            className="hidden text-[13.5px] text-inksoft transition-colors hover:text-ink sm:block"
          >
            Privacy
          </Link>
          <Link
            href="/download"
            className="rounded-full bg-accent px-4 py-1.5 text-[13.5px] font-medium text-paper transition-colors hover:bg-accentstrong"
          >
            Get MeetingAI
          </Link>
        </div>
      </nav>
    </header>
  );
}
