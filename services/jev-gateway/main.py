"""
JEV Gateway — FastAPI sidecar for TypeSafe System One classifications.

MVP endpoints:
  GET  /health
  POST /v1/route       — choose fast vs powerful model
  POST /v1/tool-risk   — is this tool call dangerous?

Does NOT execute project tools or touch the sandbox.
"""

from __future__ import annotations

import os
from typing import Any, Literal, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(
    title="my-codex JEV Gateway",
    version="0.1.0",
    description="Classification-only sidecar. Express owns tools and sandbox.",
)

PORT = int(os.getenv("JEV_GATEWAY_PORT", "8001"))
TYPESAFE_API_KEY = os.getenv("TYPESAFE_API_KEY", "").strip()


class RouteRequest(BaseModel):
    state: str = Field(..., description="Latest user message or task summary")
    userId: Optional[str] = None
    projectId: Optional[str] = None
    thread_id: Optional[str] = None


class ToolRiskRequest(BaseModel):
    state: str = Field(..., description="Tool name + args summary")
    tool_name: str = Field(default="bash")
    userId: Optional[str] = None
    projectId: Optional[str] = None
    thread_id: Optional[str] = None


class RouteResponse(BaseModel):
    choice: Literal["fast", "powerful"]
    confidence: float
    degraded: bool = False
    reason: str = ""


class ToolRiskResponse(BaseModel):
    is_risky: bool
    probability: float
    degraded: bool = False
    reason: str = ""


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "jev-gateway",
        "typesafe_configured": bool(TYPESAFE_API_KEY),
        "port": PORT,
    }


def _heuristic_route(state: str) -> RouteResponse:
    """Fallback when TypeSafe is not configured yet."""
    text = state.lower()
    hard_signals = (
        "architect",
        "refactor",
        "migrate",
        "security",
        "multi-file",
        "redesign",
        "performance",
        "debug production",
    )
    if any(s in text for s in hard_signals) or len(state) > 400:
        return RouteResponse(
            choice="powerful",
            confidence=0.55,
            degraded=True,
            reason="heuristic: complex signals (TYPESAFE_API_KEY missing or unused)",
        )
    return RouteResponse(
        choice="fast",
        confidence=0.55,
        degraded=True,
        reason="heuristic: simple task (TYPESAFE_API_KEY missing or unused)",
    )


def _heuristic_tool_risk(tool_name: str, state: str) -> ToolRiskResponse:
    """Fail-closed-ish heuristics for bash when JEV cloud unavailable."""
    text = f"{tool_name} {state}".lower()
    risky = (
        "rm -rf",
        "del /s",
        "format ",
        "shutdown",
        "mkfs",
        "drop database",
        "remove-item -recurse",
        ":/windows",
        "/etc/",
        "curl .*|",
        "invoke-expression",
    )
    hit = any(r in text for r in risky)
    return ToolRiskResponse(
        is_risky=hit,
        probability=0.9 if hit else 0.15,
        degraded=True,
        reason="heuristic tool-risk (wire TypeSafe JEV in a later pass)",
    )


@app.post("/v1/route", response_model=RouteResponse)
def classify_route(body: RouteRequest) -> RouteResponse:
    # MVP: heuristic until TypeSafe client is wired with real key.
    # Same request/response contract so Express can integrate now.
    return _heuristic_route(body.state)


@app.post("/v1/tool-risk", response_model=ToolRiskResponse)
def classify_tool_risk(body: ToolRiskRequest) -> ToolRiskResponse:
    return _heuristic_tool_risk(body.tool_name, body.state)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
