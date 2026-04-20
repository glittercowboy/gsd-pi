export type RiskLevel = "low" | "medium" | "high";

export interface WorkspaceTaskTarget {
  id: string;
  title: string;
  done: boolean;
  planPath?: string;
  summaryPath?: string;
}

export interface WorkspaceSliceTarget {
  id: string;
  title: string;
  done: boolean;
  planPath?: string;
  summaryPath?: string;
  uatPath?: string;
  tasksDir?: string;
  branch?: string;
  risk?: RiskLevel;
  depends?: string[];
  demo?: string;
  tasks: WorkspaceTaskTarget[];
}

export interface WorkspaceMilestoneTarget {
  id: string;
  title: string;
  roadmapPath?: string;
  /** Authoritative milestone lifecycle status from the GSD state registry. */
  status?: "complete" | "active" | "pending" | "parked";
  /** Milestone validation verdict, when validation has been performed. */
  validationVerdict?: "pass" | "needs-attention" | "needs-remediation";
  slices: WorkspaceSliceTarget[];
}

export interface WorkspaceScopeTarget {
  scope: string;
  label: string;
  kind: "project" | "milestone" | "slice" | "task";
}

export interface WorkspaceValidationIssue {
  message?: string;
  [key: string]: unknown;
}

export interface WorkspaceIndex {
  milestones: WorkspaceMilestoneTarget[];
  active: {
    milestoneId?: string;
    sliceId?: string;
    taskId?: string;
    phase: string;
  };
  scopes: WorkspaceScopeTarget[];
  validationIssues: WorkspaceValidationIssue[];
}
