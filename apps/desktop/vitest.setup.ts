// The renderer starts in the system language (navigator.language). The tests expect Portuguese, the source language,
// so they pass the same on any machine (the GitHub runners are in English).
Object.defineProperty(globalThis.navigator, 'language', { value: 'pt-BR', configurable: true })
