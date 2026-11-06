/**
 * Colors of the area behind the system window buttons (minimize, maximize, close) drawn over the app's top strip.
 * Windows draws that area transparent, so it follows the theme by itself. Linux does not support transparency there and
 * paints it white, so it gets the theme's background color instead.
 */
export function titleBarOverlay(platform: NodeJS.Platform, light: boolean, height: number): { color: string; symbolColor: string; height: number } {
  const color = platform === 'linux' ? (light ? '#f4f6f8' : '#0b0b0b') : '#00000000'
  return { color, symbolColor: light ? '#26303a' : '#d4d9d5', height }
}
