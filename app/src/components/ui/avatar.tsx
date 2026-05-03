import { FbIcon } from './icons'

const AVATAR_COLORS = [
  'linear-gradient(135deg, oklch(0.55 0.16 265) 0%, oklch(0.62 0.17 305) 100%)',
  'linear-gradient(135deg, oklch(0.78 0.13 75) 0%, oklch(0.65 0.18 20) 100%)',
  'linear-gradient(135deg, oklch(0.68 0.13 155) 0%, oklch(0.62 0.15 240) 100%)',
  'linear-gradient(135deg, oklch(0.62 0.17 305) 0%, oklch(0.65 0.18 20) 100%)',
  'linear-gradient(135deg, oklch(0.62 0.15 240) 0%, oklch(0.55 0.16 265) 100%)',
  'linear-gradient(135deg, oklch(0.65 0.18 20) 0%, oklch(0.78 0.13 75) 100%)',
  'linear-gradient(135deg, oklch(0.55 0.16 265) 0%, oklch(0.68 0.13 155) 100%)',
  'linear-gradient(135deg, oklch(0.78 0.13 75) 0%, oklch(0.62 0.17 305) 100%)',
]

export function avatarColor(seed: number | string): string {
  const n = typeof seed === 'string' ? seed.charCodeAt(0) + seed.charCodeAt(seed.length - 1) : seed
  return AVATAR_COLORS[Math.abs(n) % AVATAR_COLORS.length]
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

type AvatarProps = {
  name: string
  size?: number
  seed?: number | string
  channel?: 'fb' | 'ig' | null
}

export function Avatar({ name, size = 36, seed = 0, channel }: AvatarProps) {
  const bg = avatarColor(seed)
  const fontSize = Math.round(size * 0.36)

  return (
    <div
      style={{
        width: size,
        height: size,
        background: bg,
        fontSize,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        color: 'white',
        fontWeight: 700,
        flexShrink: 0,
        position: 'relative',
      }}
    >
      {initials(name)}
      {channel === 'fb' && (
        <div
          style={{
            position: 'absolute',
            bottom: -1,
            right: -1,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--color-fb)',
            display: 'grid',
            placeItems: 'center',
            border: '1.5px solid white',
          }}
        >
          <FbIcon size={8} />
        </div>
      )}
    </div>
  )
}
