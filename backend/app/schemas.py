from pydantic import BaseModel
from typing import Optional


class CreateRunRequest(BaseModel):
    seed: Optional[int] = None


class ActRequest(BaseModel):
    action: str
    node: Optional[str] = None
    card: Optional[str] = None
    target: Optional[str] = "enemy"
    option: Optional[int] = None
    branch: Optional[str] = None  # forge 动作用：强化分支 id