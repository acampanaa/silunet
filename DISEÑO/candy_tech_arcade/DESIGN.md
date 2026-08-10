---
name: Candy-Tech Arcade
colors:
  surface: '#12121d'
  surface-dim: '#12121d'
  surface-bright: '#383845'
  surface-container-lowest: '#0d0d18'
  surface-container-low: '#1b1a26'
  surface-container: '#1f1e2a'
  surface-container-high: '#292935'
  surface-container-highest: '#343440'
  on-surface: '#e3e0f1'
  on-surface-variant: '#dfbec8'
  inverse-surface: '#e3e0f1'
  inverse-on-surface: '#302f3b'
  outline: '#a68993'
  outline-variant: '#584049'
  surface-tint: '#ffb0ce'
  primary: '#ffb0ce'
  on-primary: '#64003a'
  primary-container: '#fa4ca3'
  on-primary-container: '#570032'
  inverse-primary: '#b7036f'
  secondary: '#5de6ff'
  on-secondary: '#00363e'
  secondary-container: '#00cbe6'
  on-secondary-container: '#00515d'
  tertiary: '#98da27'
  on-tertiary: '#213600'
  tertiary-container: '#6ba000'
  on-tertiary-container: '#1c2f00'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffd9e5'
  primary-fixed-dim: '#ffb0ce'
  on-primary-fixed: '#3e0022'
  on-primary-fixed-variant: '#8c0054'
  secondary-fixed: '#a2eeff'
  secondary-fixed-dim: '#2fd9f4'
  on-secondary-fixed: '#001f25'
  on-secondary-fixed-variant: '#004e5a'
  tertiary-fixed: '#b2f746'
  tertiary-fixed-dim: '#98da27'
  on-tertiary-fixed: '#121f00'
  on-tertiary-fixed-variant: '#334f00'
  background: '#12121d'
  on-background: '#e3e0f1'
  surface-variant: '#343440'
typography:
  display-lg:
    fontFamily: Sora
    fontSize: 48px
    fontWeight: '800'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  display-lg-mobile:
    fontFamily: Sora
    fontSize: 32px
    fontWeight: '800'
    lineHeight: '1.2'
  headline-md:
    fontFamily: Sora
    fontSize: 24px
    fontWeight: '700'
    lineHeight: '1.3'
  body-base:
    fontFamily: Sora
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.5'
    letterSpacing: 0.05em
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '700'
    lineHeight: '1'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base-unit: 8px
  container-max-width: 1280px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
---

## Brand & Style
The design system adopts a **Candy-Tech** aesthetic, merging the high-energy pulse of a modern arcade with the precision of a technical platform. It is designed for high-stakes contests and live events where excitement and clarity must coexist. 

The visual style leans into a **Modern-Vaporwave** hybrid: deep, expansive dark surfaces paired with ultra-vibrant, glowing accents. The emotional response is one of adrenaline, fairness, and technological sophistication. This is achieved through high-contrast interfaces, glowing "neon" indicators, and a playful yet disciplined layout.

## Colors
This design system utilizes a dark-mode-first palette to allow vibrant accents to "pop" as if they were illuminated displays.

- **Primary Accent (Fuchsia):** Used for the most critical actions, branding, and high-hierarchy highlights. It represents the "energy" of the platform.
- **Secondary Accent (Cyan):** Dedicated to dynamic information—live timers, data streams, and active status chips. It provides a "tech" cooling balance to the fuchsia.
- **Success Accent (Lime):** Reserved for positive outcomes, active states, and correct answers. It is the highest-visibility color for feedback.
- **Base Layers:** The background is a deep **Dark Navy (#0F0F1A)**, providing a void-like canvas. UI containers and cards use **Dark Slate (#1A1A2E)** to create subtle depth without losing the high-contrast impact.

## Typography
The typography system balances the expressive, geometric nature of **Sora** with the technical rigor of **JetBrains Mono**.

- **Headlines & Display:** Use Sora with heavy weights (700-800). Tight letter spacing on large displays creates a "poster" feel suitable for contest leaderboards.
- **Technical Data:** Any live numbers, timestamps, or system logs must use JetBrains Mono. This ensures alignment and reinforces the "tech" aspect of the arcade theme.
- **Body Text:** Sora at regular weights ensures high readability against dark backgrounds.

## Layout & Spacing
The layout follows a **structured fluid grid** with a strong emphasis on modularity. 

- **Grid:** A 12-column system is used for desktop, collapsing to 4 columns on mobile. 
- **Rhythm:** Spacing is strictly based on 8px increments. Larger gaps (32px, 48px) are encouraged between major sections to prevent the dark UI from feeling cramped.
- **Adaptation:** On mobile, cards should extend to the edge of the margins, and typography should scale aggressively to maintain the "big screen" arcade energy.

## Elevation & Depth
In this design system, depth is conveyed through **chromatic glow** rather than traditional shadows.

- **Layering:** The primary background is the lowest level. Cards use a slightly lighter fill to appear closer to the user.
- **Neon Strokes:** Instead of drop shadows, active or elevated elements use a 1px inner or outer border in a semi-transparent version of the primary or secondary color (e.g., Fuchsia at 30% opacity).
- **Backdrop Blurs:** Modals and overlays use a high-intensity backdrop blur (20px+) with a dark tint to maintain focus while showing the vibrant colors of the background beneath.

## Shapes
The shape language is **Rounded**, striking a balance between the friendliness of a "candy" theme and the precision of technology.

- **Base Radius:** 0.5rem (8px) for standard components like input fields and small buttons.
- **Large Radius:** 1rem (16px) for main content cards and section containers.
- **Interactive Elements:** Buttons and tags may occasionally use "pill" shapes (full rounding) to denote high interactivity or status.

## Components
- **Buttons:** Primary buttons use a solid Fuchsia fill with white or near-black text. Secondary buttons use a Cyan outline with a subtle glow effect on hover.
- **Status Chips:** Use JetBrains Mono for text. "Live" chips should use Cyan with a pulsing animation. "Correct/Success" chips use a Lime background.
- **Input Fields:** Dark Navy background with a 1px Slate border. On focus, the border transitions to a glowing Cyan.
- **Cards:** Use the #1A1A2E surface color. For "featured" cards, a top-border gradient of Fuchsia-to-Cyan is applied to denote importance.
- **Progress Bars:** Use a dual-color track—a dark base with a vibrant Cyan or Fuchsia fill that features a "shimmer" animation to suggest activity.
- **Leaderboards:** Use high-contrast rows with Monospace technical data for score alignment. The top-ranked item should receive a subtle Fuchsia outer glow.