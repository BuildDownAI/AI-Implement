// Operator-captured workflow capability facts; see provenance below.
export default {
  "workflowCutoff": "2026-11-08T00:00:00Z",
  "mappingProvenance": "Live mapping coordinates read 2026-11-09; historical mapping settings not claimed. Workflow facts are from immutable repo history before 2026-11-08T00:00Z.",
  "captureProvenance": "Operator-authenticated get_project_binding/list_projects on buildown-orchestrator; gh api repos/{repo}/commits?sha={configuredRef}&until=2026-11-08T00%3A00%3A00Z&per_page=1, then repos/{repo}/contents/.github/workflows/{file}?ref={commitAsOfDate}. Capabilities captured using the workflow probe; raw workflow contents are not included. This is not a historical deployment-settings export.",
  "projects": [
    {
      "team": "SAN",
      "repository": "BuildDownAI/AI-Implement-Sandbox",
      "configuredRef": "main",
      "workflowFile": "claude-implement-2.yml",
      "planningWorkflowFile": "claude-plan-2.yml",
      "planningEnabled": true,
      "executionMode": "github-actions",
      "commitAsOfDate": "b9120cb7e49d9fd0f5adacc0cfa52773ab706938",
      "expectedState": "warn",
      "files": {
        "claude-implement-2.yml": {
          "blobSha": "8802c7f340ad305985ee309f59174b01ad2a185d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": true,
            "supportsAttemptCorrelation": true,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "claude-plan-2.yml": {
          "blobSha": "8044084b5cfb7cf04e6c10a349478ea33765451d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": false,
            "supportsAttemptCorrelation": false,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "comment-trigger.yml": {
          "missing": true
        },
        "claude-kg-refresh.yml": {
          "missing": true
        }
      }
    },
    {
      "team": "KGB",
      "repository": "BuildDownAI/bd-knowledge-graph-base",
      "configuredRef": "testing",
      "workflowFile": "claude-implement.yml",
      "planningWorkflowFile": "claude-plan.yml",
      "planningEnabled": true,
      "executionMode": "github-actions",
      "commitAsOfDate": "80a623afb0bf71f0ab7af1f1db249db0686176ba",
      "expectedState": "warn",
      "files": {
        "claude-implement.yml": {
          "blobSha": "8802c7f340ad305985ee309f59174b01ad2a185d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": true,
            "supportsAttemptCorrelation": true,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "claude-plan.yml": {
          "blobSha": "8044084b5cfb7cf04e6c10a349478ea33765451d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": false,
            "supportsAttemptCorrelation": false,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "comment-trigger.yml": {
          "missing": true
        },
        "claude-kg-refresh.yml": {
          "missing": true
        }
      }
    },
    {
      "team": "DOC",
      "repository": "BuildDownAI/docs",
      "configuredRef": "main",
      "workflowFile": "claude-implement.yml",
      "planningWorkflowFile": "claude-plan.yml",
      "planningEnabled": false,
      "executionMode": "github-actions",
      "commitAsOfDate": "9feea619867767cc710ea835239f306807e6ae52",
      "expectedState": "warn",
      "files": {
        "claude-implement.yml": {
          "blobSha": "8802c7f340ad305985ee309f59174b01ad2a185d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": true,
            "supportsAttemptCorrelation": true,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "comment-trigger.yml": {
          "missing": true
        },
        "claude-kg-refresh.yml": {
          "missing": true
        }
      }
    },
    {
      "team": "KGA",
      "repository": "BuildDownAI/knowledge-graph-ai-implement",
      "configuredRef": "main",
      "workflowFile": "claude-implement.yml",
      "planningWorkflowFile": "claude-plan.yml",
      "planningEnabled": true,
      "executionMode": "github-actions",
      "commitAsOfDate": "ba6d57a7d383ccf2d81bf8f8a804be299e339c0a",
      "expectedState": "warn",
      "files": {
        "claude-implement.yml": {
          "blobSha": "8802c7f340ad305985ee309f59174b01ad2a185d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": true,
            "supportsAttemptCorrelation": true,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "claude-plan.yml": {
          "blobSha": "8044084b5cfb7cf04e6c10a349478ea33765451d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": false,
            "supportsAttemptCorrelation": false,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "comment-trigger.yml": {
          "missing": true
        },
        "claude-kg-refresh.yml": {
          "missing": true
        }
      }
    },
    {
      "team": "BDS",
      "repository": "BuildDownAI/skills",
      "configuredRef": "testing",
      "workflowFile": "claude-implement.yml",
      "planningWorkflowFile": "claude-plan.yml",
      "planningEnabled": true,
      "executionMode": "github-actions",
      "commitAsOfDate": "eb5c4e9b55aa21d0f811cd2fb8ab9a570c7cd558",
      "expectedState": "warn",
      "files": {
        "claude-implement.yml": {
          "blobSha": "8802c7f340ad305985ee309f59174b01ad2a185d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": true,
            "supportsAttemptCorrelation": true,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "claude-plan.yml": {
          "blobSha": "8044084b5cfb7cf04e6c10a349478ea33765451d",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": false,
            "hasStageAgentLaunchContextMarker": false,
            "supportsRunPublicationToken": false,
            "supportsAttemptCorrelation": false,
            "supportsPrivateRunConfig": false,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": false
          }
        },
        "comment-trigger.yml": {
          "missing": true
        },
        "claude-kg-refresh.yml": {
          "missing": true
        }
      }
    },
    {
      "team": "TEST",
      "repository": "BuildDownAI/codex-sandbox-repo",
      "configuredRef": "main",
      "workflowFile": "claude-implement.yml",
      "planningWorkflowFile": "claude-plan.yml",
      "planningEnabled": true,
      "executionMode": "github-actions",
      "commitAsOfDate": "a128d1ec74144f80428717f86e83ebe47e668151",
      "expectedState": "pass",
      "files": {
        "claude-implement.yml": {
          "blobSha": "3e89f3bfdba987dde38ba82d9249f9731c591a44",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": true,
            "hasStageAgentLaunchContextMarker": true,
            "supportsRunPublicationToken": true,
            "supportsAttemptCorrelation": true,
            "supportsPrivateRunConfig": true,
            "supportsExecutionPolicy": true,
            "supportsStageAgentConfig": true
          }
        },
        "claude-plan.yml": {
          "blobSha": "f7bb4a72b00b3d0b10740b8dce5c3d29804989ec",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": true,
            "hasStageAgentLaunchContextMarker": true,
            "supportsRunPublicationToken": false,
            "supportsAttemptCorrelation": false,
            "supportsPrivateRunConfig": true,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": true
          }
        },
        "comment-trigger.yml": {
          "missing": true
        },
        "claude-kg-refresh.yml": {
          "missing": true
        }
      }
    },
    {
      "team": "AII",
      "repository": "BuildDownAI/AI-Implement",
      "configuredRef": "testing",
      "workflowFile": "claude-implement.yml",
      "planningWorkflowFile": "claude-plan.yml",
      "planningEnabled": true,
      "executionMode": "github-actions",
      "commitAsOfDate": "d39c8a57e9fc9f9593380fd16678e7180adadbc7",
      "expectedState": "pass",
      "files": {
        "claude-implement.yml": {
          "blobSha": "62e97a00172b563025c5603e5413fa3262be7271",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": true,
            "hasStageAgentLaunchContextMarker": true,
            "supportsRunPublicationToken": true,
            "supportsAttemptCorrelation": true,
            "supportsPrivateRunConfig": true,
            "supportsExecutionPolicy": true,
            "supportsStageAgentConfig": true
          }
        },
        "claude-plan.yml": {
          "blobSha": "189b6ecae28bca2c828266482d90ca3872291e35",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": true,
            "hasStageAgentLaunchContextMarker": true,
            "supportsRunPublicationToken": false,
            "supportsAttemptCorrelation": false,
            "supportsPrivateRunConfig": true,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": true
          }
        },
        "comment-trigger.yml": {
          "missing": true
        },
        "claude-kg-refresh.yml": {
          "missing": true
        }
      }
    },
    {
      "team": "CON",
      "repository": "BuildDownAI/Control-Plane",
      "configuredRef": "testing",
      "workflowFile": "claude-implement.yml",
      "planningWorkflowFile": "claude-plan.yml",
      "planningEnabled": true,
      "executionMode": "github-actions",
      "commitAsOfDate": "784ae7c04ed76eddf6d355235fc49a4e1895812b",
      "expectedState": "pass",
      "files": {
        "claude-implement.yml": {
          "blobSha": "62e97a00172b563025c5603e5413fa3262be7271",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": true,
            "hasStageAgentLaunchContextMarker": true,
            "supportsRunPublicationToken": true,
            "supportsAttemptCorrelation": true,
            "supportsPrivateRunConfig": true,
            "supportsExecutionPolicy": true,
            "supportsStageAgentConfig": true
          }
        },
        "claude-plan.yml": {
          "blobSha": "189b6ecae28bca2c828266482d90ca3872291e35",
          "capabilities": {
            "contract": "envelope",
            "hasStageAgentConfigMarker": true,
            "hasStageAgentLaunchContextMarker": true,
            "supportsRunPublicationToken": false,
            "supportsAttemptCorrelation": false,
            "supportsPrivateRunConfig": true,
            "supportsExecutionPolicy": false,
            "supportsStageAgentConfig": true
          }
        },
        "comment-trigger.yml": {
          "missing": true
        },
        "claude-kg-refresh.yml": {
          "missing": true
        }
      }
    }
  ]
} as const;
