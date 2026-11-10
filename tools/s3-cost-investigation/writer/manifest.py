"""Hash producing inputs and local generated artifacts without committing them."""
import hashlib,json,os,platform,shutil,subprocess,sys
from pathlib import Path
scratch=Path(sys.argv[1]); root=Path(__file__).resolve().parents[3]
harness=scratch/'harness' if (scratch/'harness').exists() else scratch/'probe/harness'
paths=[root/'tools/compression-bench/src/main.rs',Path(__file__).with_name('prepare.py'), harness/'src/main.rs',harness/'Cargo.toml',harness/'Cargo.lock']
for arm in ('dictionary','delta','smoke'):
 if (scratch/arm).exists(): paths+=sorted((scratch/arm).glob('*'))
files={str(p):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths if p.is_file()}
print(json.dumps({'base_revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'platform':platform.platform(),'cpu':next(x.split(':',1)[1].strip() for x in Path('/proc/cpuinfo').read_text().splitlines() if x.startswith('model name')),'affinity':sorted(os.sched_getaffinity(0)),'compiler':subprocess.check_output([shutil.which('rustc') or str(Path.home()/'.cargo/bin/rustc'),'-Vv'],text=True),'profile':'release-lto: opt-level3, fat LTO, codegen-units1; jemalloc exact codec/allocator feature audit','files':files},indent=2))
