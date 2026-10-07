import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aangan Studio · Enquiries",
  description: "Phone enquiry handling for Aangan Studio",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
