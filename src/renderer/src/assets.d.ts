// Vite turns an imported asset into its URL
declare module '*.svg' {
  const url: string
  export default url
}
