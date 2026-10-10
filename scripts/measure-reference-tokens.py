"""Optional benchmark-only tokenizer. Install tiktoken==0.12.0 outside runtime dependencies."""
import json
import sys
import importlib.metadata
import tiktoken

if importlib.metadata.version("tiktoken") != "0.12.0":
    raise RuntimeError("Use the pinned reference tokenizer version 0.12.0")
payload = json.load(sys.stdin)
encoding = tiktoken.get_encoding("o200k_base")
print(json.dumps({key: len(encoding.encode(value, disallowed_special=())) for key, value in payload.items()}))
