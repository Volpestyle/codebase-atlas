import type { RepositoryNodeKind } from "../model";

/* Bridges tokens.css into renderers that cannot read CSS variables (the
   three.js map, canvas label textures). Resolve palettes inside mount/effect
   code, not at module scope, so stylesheets are attached before reading. */

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function tokenHex(name: string): number {
  return Number.parseInt(token(name).replace("#", ""), 16);
}

export interface MapPalette {
  paper: number;
  /** --paper as a CSS string for canvas label plates. */
  paperCss: string;
  ink: string;
  rust: number;
  outline: number;
  glow: number;
  hover: number;
  searchHit: number;
  importSource: number;
  importTarget: number;
  gridMajor: number;
  gridMinor: number;
  directoryAlt: number;
  kind: Record<RepositoryNodeKind, number>;
  fontMono: string;
}

export function mapPalette(): MapPalette {
  return {
    paper: tokenHex("--paper"),
    paperCss: token("--paper"),
    ink: token("--ink"),
    rust: tokenHex("--rust"),
    outline: tokenHex("--map-outline"),
    glow: tokenHex("--map-glow"),
    hover: tokenHex("--map-hover"),
    searchHit: tokenHex("--map-search-hit"),
    importSource: tokenHex("--map-import-source"),
    importTarget: tokenHex("--map-import-target"),
    gridMajor: tokenHex("--map-grid-major"),
    gridMinor: tokenHex("--map-grid-minor"),
    directoryAlt: tokenHex("--map-directory-alt"),
    kind: {
      repository: tokenHex("--map-repository"),
      directory: tokenHex("--map-directory"),
      source: tokenHex("--map-source"),
      config: tokenHex("--map-config"),
      documentation: tokenHex("--map-documentation"),
      asset: tokenHex("--map-asset"),
    },
    fontMono: token("--font-mono"),
  };
}
