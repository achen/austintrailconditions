import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Austin Trail Conditions',
  description: 'Real-time mountain bike trail conditions for Central Texas trails. Check if trails are dry and rideable after rain.',
  openGraph: {
    title: 'Austin Trail Conditions',
    description: 'Real-time mountain bike trail conditions for Central Texas.',
    siteName: 'Austin Trail Conditions',
    type: 'website',
    images: [{ url: '/opengraph-image', width: 600, height: 1200 }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
