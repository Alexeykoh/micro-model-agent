import type { ProfileInfo } from './profile'

export class ProfileCompressor {
  compress(info: ProfileInfo): string {
    const parts: string[] = [
      `OS: ${info.os}`,
      `Shell: ${info.shell}`,
      `Platform: ${info.platform}`,
    ]

    if (Object.keys(info.preferences).length > 0) {
      const prefs = Object.entries(info.preferences)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      parts.push(`Prefs: ${prefs}`)
    }

    return parts.join(', ')
  }
}
