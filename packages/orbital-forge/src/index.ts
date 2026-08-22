export interface ForgeTemplate {
  readonly id: string;
  readonly description: string;
}

export interface GeneratedFile {
  readonly path: string;
  readonly contents: string;
}

export interface ForgeScaffoldOptions {
  readonly templateId: string;
  readonly targetName: string;
  readonly variables?: Record<string, string>;
}

/**
 * Scaffolding engine. Renders templates into an in-memory file map;
 * writing to disk is a separate, explicit step so callers can preview.
 */
export class Forge {
  private readonly templates = new Map<string, ForgeTemplate>();

  registerTemplate(template: ForgeTemplate): void {
    this.templates.set(template.id, template);
  }

  listTemplates(): readonly ForgeTemplate[] {
    return [...this.templates.values()];
  }

  scaffold(options: ForgeScaffoldOptions): readonly GeneratedFile[] {
    if (!this.templates.has(options.templateId)) {
      throw new Error(`Unknown forge template: ${options.templateId}`);
    }

    const variables = {
      name: options.targetName,
      ...options.variables
    };

    return [
      {
        path: `${options.targetName}/README.md`,
        contents: `# ${variables.name}\n\nGenerated from template "${options.templateId}".\n`
      }
    ];
  }
}
