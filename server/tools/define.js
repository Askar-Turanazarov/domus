// A tool description as 08 §2 shows it (its own file: the tools import it, the registry imports the tools).
export const SOURCES = ['agent', 'mcp'];

export const defineTool = d => Object.freeze({ sources: SOURCES, forModel: out => out, redact: args => args, ...d });
