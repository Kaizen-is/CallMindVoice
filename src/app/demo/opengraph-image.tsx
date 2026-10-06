/**
 * The link preview for /demo — what a Telegram or WhatsApp chat shows when a
 * guide shares the link. Same orb, same name, no words that need a font the
 * default renderer lacks (it has no Cyrillic and no ʻ).
 */
import { ImageResponse } from 'next/og';

export const alt = 'Isomiddin — AI voice assistant of Biznesni rivojlantirish banki';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const ORB = [
  'radial-gradient(circle at 34% 24%, rgba(255,255,255,0.62), rgba(255,255,255,0) 30%)',
  'radial-gradient(circle at 28% 66%, rgba(126,234,255,0.95), rgba(126,234,255,0) 52%)',
  'radial-gradient(circle at 72% 30%, rgba(202,92,255,0.95), rgba(202,92,255,0) 54%)',
  'radial-gradient(circle at 42% 38%, rgba(112,128,255,0.9), rgba(112,128,255,0) 58%)',
  'radial-gradient(circle at 70% 72%, rgba(255,150,120,0.45), rgba(255,150,120,0) 40%)',
  'radial-gradient(circle at 50% 100%, #3a2a80, #15103a 72%)',
].join(', ');

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 96px',
          color: '#f4f4f8',
          backgroundColor: '#0d0d14',
          backgroundImage:
            'radial-gradient(circle at 76% 50%, rgba(120,96,255,0.32), rgba(120,96,255,0) 42%), radial-gradient(circle at 10% 100%, rgba(40,200,220,0.12), rgba(40,200,220,0) 40%)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', fontSize: 28, color: '#a9a9bb' }}>
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                marginRight: 14,
                backgroundColor: '#22c55e',
                boxShadow: '0 0 0 6px rgba(34,197,94,0.18)',
              }}
            />
            Incoming call
          </div>
          <div style={{ fontSize: 112, fontWeight: 700, letterSpacing: -4, marginTop: 26, lineHeight: 1 }}>
            Isomiddin
          </div>
          <div style={{ fontSize: 38, color: '#c9c9d6', marginTop: 22, lineHeight: 1.3 }}>
            Biznesni rivojlantirish banki
          </div>
          <div style={{ display: 'flex', marginTop: 46, fontSize: 26, color: '#8a8aa0' }}>
            CallMind AI · Uzbek & Russian · live demo
          </div>
        </div>
        <div
          style={{
            width: 360,
            height: 360,
            borderRadius: 180,
            backgroundImage: ORB,
            boxShadow: '0 40px 120px rgba(110,80,255,0.45), inset 0 0 0 2px rgba(255,255,255,0.12)',
          }}
        />
      </div>
    ),
    size,
  );
}
