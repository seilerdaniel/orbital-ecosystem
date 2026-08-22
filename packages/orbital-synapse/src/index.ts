export interface OrbitalAgent {
  readonly name: string;
  handle(input: string): string;
}

/**
 * Routes work to registered agents. Acts as the nervous system between
 * the user-facing apps (dock, mobile, cli) and the capability packages.
 */
export class Synapse {
  private readonly agents = new Map<string, OrbitalAgent>();

  register(agent: OrbitalAgent): void {
    this.agents.set(agent.name, agent);
  }

  listAgents(): readonly string[] {
    return [...this.agents.keys()];
  }

  dispatch(agentName: string, input: string): string {
    const agent = this.agents.get(agentName);

    if (agent === undefined) {
      throw new Error(
        `No agent registered as "${agentName}". Available: ${this.listAgents().join(", ") || "none"}`
      );
    }

    return agent.handle(input);
  }
}
