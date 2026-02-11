import React from "react"
import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { AppProviders } from "@/components/app-providers"
import './globals.css'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: 'Sentryield',
  description: 'AI-powered yield optimization agent for Monad',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/SentryieldIconBlack.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/SentryieldIconWhite.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/SentryieldIconBlack.svg',
        media: '(prefers-color-scheme: light)',
        type: 'image/svg+xml',
      },
      {
        url: '/SentryieldIconWhite.svg',
        media: '(prefers-color-scheme: dark)',
        type: 'image/svg+xml',
      },
    ],
    apple: '/SentryieldIconBlack.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`font-sans antialiased`}>
        <AppProviders>{children}</AppProviders>
        <Analytics />
      </body>
    </html>
  )
}
