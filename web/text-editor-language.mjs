const languageByExtension = new Map([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".json", "json"],
  [".jsonc", "json"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".html", "html"],
  [".htm", "html"],
  [".css", "css"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "jsx"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".go", "go"],
  [".py", "python"],
  [".php", "php"],
  [".java", "java"],
  [".c", "cpp"],
  [".h", "cpp"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".rs", "rust"],
  [".sql", "sql"],
]);

export function textEditorLanguageID(path) {
  const name = (path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? languageByExtension.get(name.slice(dot)) || "" : "";
}
