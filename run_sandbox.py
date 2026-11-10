import sys
import json
import os

code_to_run = sys.stdin.read()
api_key = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("NOVITA_API_KEY")

os.environ["NOVITA_API_KEY"] = api_key

try:
    from novita_sandbox.code_interpreter import Sandbox
    sbx = Sandbox.create(timeout=90)
    try:
        res = sbx.run_code(code_to_run)
        stdout = "".join(res.logs.stdout)
        stderr = "".join(res.logs.stderr)
        output = {
            "success": True,
            "sandbox_id": sbx.sandbox_id,
            "stdout": stdout,
            "stderr": stderr,
            "results": [str(r) for r in res.results] if hasattr(res, 'results') else []
        }
    finally:
        sbx.kill()
except Exception as e:
    output = {
        "success": False,
        "error": str(e)
    }

print(json.dumps(output))
