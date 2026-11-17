import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = value => { if (!value) throw Error('Canary control guard failed'); };
const moduleSha256 = 'fcb260ebc47901fb3ea817a4da8f67df91262ec125cad4ad7c03a0db2481fcb2';
// Exact reviewed source artifact: stdin executes these verified bytes, never a
// privileged import from the application's mutable user-owned checkout.
const frozenSource = 'aW1wb3J0IGZzIGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnOwppbXBvcnQgeyBjb25zdGFudHMgfSBmcm9tICdub2RlOmZzJzsKaW1wb3J0IHBhdGggZnJvbSAnbm9kZTpwYXRoJzsKaW1wb3J0IHsgY3JlYXRlSGFzaCwgcmFuZG9tQnl0ZXMsIHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7CmltcG9ydCB7IGV4ZWNGaWxlIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJzsKaW1wb3J0IHsgcHJvbWlzaWZ5IH0gZnJvbSAnbm9kZTp1dGlsJzsKCmNvbnN0IHNoYSA9IGJ5dGVzID0+IGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShieXRlcykuZGlnZXN0KCdoZXgnKTsKY29uc3QgbmVlZCA9IHZhbHVlID0+IHsgaWYgKCF2YWx1ZSkgdGhyb3cgRXJyb3IoJ0NhbmFyeSBndWFyZCBmYWlsZWQnKTsgfTsKY29uc3QgaGFzaGVzID0gT2JqZWN0LmZyZWV6ZSh7IG1haW46ICc0ODY5Y2RkY2UxMDMwY2VmZmI5OWJmODhiMWE2NGEwZWMyYjVkNTFjMGMyMzc3OTU4ZjQ4NTMzYmFlMzIwNTIyJywKICBzaXRlOiAnZWQ4ODQzNjI5ZTZmM2JkZTUyMzFkNDIwM2JlMjMyZjA4MzU2NjdiMGZhNTE0NzFlOTRmY2U4ZjViYzU2NWExOCcgfSk7CmNvbnN0IGZpbGVzID0gT2JqZWN0LmZyZWV6ZSh7IG1haW46ICcvZXRjL25naW54L25naW54LmNvbmYnLCBzaXRlOiAnL2V0Yy9uZ2lueC9zaXRlcy1hdmFpbGFibGUvbWF0dGVyJyB9KTsKY29uc3QgbGluayA9ICcvZXRjL25naW54L3NpdGVzLWVuYWJsZWQvbWF0dGVyJywgc3RvcmFnZSA9ICcvdmFyL2xpYi9tYXR0ZXItZHJpdmVyLXJlcG9ydHMtY2FuYXJ5JzsKY29uc3Qgc2lnbmF0dXJlID0gaW5mbyA9PiBbaW5mby5kZXYsIGluZm8uaW5vLCBpbmZvLnVpZCwgaW5mby5naWQsIGluZm8ubW9kZSwgaW5mby5zaXplLCBpbmZvLm10aW1lTnMsIGluZm8uY3RpbWVOc10ubWFwKFN0cmluZykuam9pbignOicpOwpjb25zdCBpZGVudGl0eSA9IGluZm8gPT4gW2luZm8uZGV2LCBpbmZvLmlubywgaW5mby51aWQsIGluZm8uZ2lkLCBpbmZvLm1vZGVdLm1hcChTdHJpbmcpLmpvaW4oJzonKTsKY29uc3QgZGVjb2RlID0gdmFsdWUgPT4gQnVmZmVyLmZyb20odmFsdWUsICdiYXNlNjQnKTsKY29uc3QgYmxvY2sgPSAoa2luZCwgYm9keSwgaW5kZW50YXRpb24gPSAnJykgPT4gaW5kZW50YXRpb24gKyAnIyBCRUdJTiBNQVRURVIgUkVQT1JUUyBDQU5BUlkgJyArIGtpbmQgKyAnXG4nCiAgKyBib2R5ICsgaW5kZW50YXRpb24gKyAnIyBFTkQgTUFUVEVSIFJFUE9SVFMgQ0FOQVJZICcgKyBraW5kICsgJ1xuJzsKY29uc3Qgb25jZSA9ICh0ZXh0LCBuZWVkbGUsIHJlcGxhY2VtZW50KSA9PiB7IG5lZWQodGV4dC5zcGxpdChuZWVkbGUpLmxlbmd0aCA9PT0gMik7IHJldHVybiB0ZXh0LnJlcGxhY2UobmVlZGxlLCByZXBsYWNlbWVudCk7IH07CgovLyBUaGUgcGxhbiBhbmQgZGlmZiBjb250YWluIHRoZSBwcml2YXRlIHNlbGVjdG9yL2NvbmZpZ3VyYXRpb24uIFN0b3JlIG9yIHNlYWwKLy8gdGhlbSBwcml2YXRlbHk7IHRoZSBleGVjdXRpbmcgZnVuY3Rpb25zIHJldHVybiBvbmx5IHN0YXR1cyBhbmQgaGFzaGVzLgpleHBvcnQgZnVuY3Rpb24gY3JlYXRlRHJpdmVyQXVkaXRTdXBhYmFzZUNhbmFyeVBsYW4oeyBtYWluLCBzaXRlLCBzZWxlY3RvciA9IHJhbmRvbUJ5dGVzKDMyKS50b1N0cmluZygnaGV4JyksCiAgZW50cnlOb25jZSA9IHJhbmRvbUJ5dGVzKDMyKS50b1N0cmluZygnaGV4JyksIGlzc3VlZEF0ID0gbmV3IERhdGUoTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKiAxMDAwKS50b0lTT1N0cmluZygpLCB0dGxTZWNvbmRzID0gNjAwIH0sIGFkYXB0ZXJzID0ge30pIHsKICBjb25zdCBwaW5zID0gYWRhcHRlcnMuaGFzaGVzID8/IGhhc2hlczsKICBuZWVkKEJ1ZmZlci5pc0J1ZmZlcihtYWluKSAmJiBCdWZmZXIuaXNCdWZmZXIoc2l0ZSkgJiYgbWFpbi5sZW5ndGggPD0gMTI4ICogMTAyNCAmJiBzaXRlLmxlbmd0aCA8PSAxMjggKiAxMDI0CiAgICAmJiBzaGEobWFpbikgPT09IHBpbnMubWFpbiAmJiBzaGEoc2l0ZSkgPT09IHBpbnMuc2l0ZSAmJiAvXlthLWYwLTldezY0fSQvLnRlc3Qoc2VsZWN0b3IpCiAgICAmJiAvXlthLWYwLTldezY0fSQvLnRlc3QoZW50cnlOb25jZSkgJiYgc2VsZWN0b3IgIT09IGVudHJ5Tm9uY2UgJiYgTnVtYmVyLmlzSW50ZWdlcih0dGxTZWNvbmRzKSAmJiB0dGxTZWNvbmRzID49IDYwICYmIHR0bFNlY29uZHMgPD0gOTAwKTsKICBjb25zdCBzdGFydCA9IERhdGUucGFyc2UoaXNzdWVkQXQpOyBuZWVkKE51bWJlci5pc0Zpbml0ZShzdGFydCkgJiYgc3RhcnQgJSAxMDAwID09PSAwICYmIG5ldyBEYXRlKHN0YXJ0KS50b0lTT1N0cmluZygpID09PSBpc3N1ZWRBdCk7CiAgY29uc3QgZXhwaXJlc0F0ID0gbmV3IERhdGUoc3RhcnQgKyB0dGxTZWNvbmRzICogMTAwMCkudG9JU09TdHJpbmcoKTsKICAvLyBOZ2lueCByZWplY3RzIGEgc2luZ2xlIDQwOTYtYnl0ZSBjb25maWd1cmF0aW9uIHRva2VuLiBLZWVwIGVhY2ggZXhhY3QKICAvLyBlcG9jaCBhbGxvd2xpc3Qgcm93IHNtYWxsIGluc3RlYWQgb2YgZ3Jvd2luZyBvbmUgdG9rZW4gd2l0aCB0aGUgd2luZG93LgogIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9uZ2lueC9uZ2lueC9ibG9iL3JlbGVhc2UtMS4xOC4wL3NyYy9jb3JlL25neF9jb25mX2ZpbGUuYwogIGNvbnN0IGVwb2NocyA9IEFycmF5LmZyb20oeyBsZW5ndGg6IE1hdGguY2VpbCh0dGxTZWNvbmRzIC8gNjApIH0sIChfLCBjaHVuaykgPT4KICAgIEFycmF5LmZyb20oeyBsZW5ndGg6IE1hdGgubWluKDYwLCB0dGxTZWNvbmRzIC0gY2h1bmsgKiA2MCkgfSwgKF8sIGkpID0+IHN0YXJ0IC8gMTAwMCArIGNodW5rICogNjAgKyBpKS5qb2luKCd8JykpOwogIGNvbnN0IHNjb3BlID0gJyg/Oi9kcml2ZXItYXVkaXQtdmlld3wvYXBpL2RyaXZlci1hdWRpdHMvc2Vzc2lvbnwvYXBpL3Nlc3Npb24oPzovcmVmcmVzaCk/fC9hcGkvcmVwb3J0aW5nLy4qfC9yZXBvcnQtZGF0YS8uKnwvcmVwb3J0LWFzc2V0cy8uKiknOwogIGNvbnN0IG1hcCA9IGJsb2NrKCdNQVAnLCAnbWFwICIkY29va2llX21hdHRlcl9kcml2ZXJfcmVwb3J0c19jYW5hcnk6JG1zZWM6JHVyaSIgJG1hdHRlcl9kcml2ZXJfcmVwb3J0c19jYW5hcnkge1xuJwogICAgKyAnICAgIGRlZmF1bHQgMDtcbicgKyBlcG9jaHMubWFwKGVwb2NoID0+ICcgICAgIn5eJyArIHNlbGVjdG9yICsgJzooPzonICsgZXBvY2ggKyAnKVsuXVswLTldKzonICsgc2NvcGUgKyAnJCIgMTtcbicpLmpvaW4oJycpICsgJ31cbicKICAgICsgJ21hcCAkbXNlYyAkbWF0dGVyX2RyaXZlcl9yZXBvcnRzX2NhbmFyeV9lbnRyeSB7XG4gICAgZGVmYXVsdCAwO1xuJwogICAgKyBlcG9jaHMubWFwKGVwb2NoID0+ICcgICAgIn5eKD86JyArIGVwb2NoICsgJylbLl1bMC05XSskIiAxO1xuJykuam9pbignJykgKyAnfVxuJyk7CiAgY29uc3Qgb3JpZ2luYWxNYWluID0gbWFpbi50b1N0cmluZygndXRmOCcpLCBvcmlnaW5hbFNpdGUgPSBzaXRlLnRvU3RyaW5nKCd1dGY4Jyk7CiAgbmVlZChCdWZmZXIuZnJvbShvcmlnaW5hbE1haW4pLmVxdWFscyhtYWluKSAmJiBCdWZmZXIuZnJvbShvcmlnaW5hbFNpdGUpLmVxdWFscyhzaXRlKQogICAgJiYgIW9yaWdpbmFsTWFpbi5pbmNsdWRlcygnTUFUVEVSIFJFUE9SVFMgQ0FOQVJZJykgJiYgIW9yaWdpbmFsU2l0ZS5pbmNsdWRlcygnTUFUVEVSIFJFUE9SVFMgQ0FOQVJZJykpOwogIGNvbnN0IGVuYWJsZWRNYWluID0gb25jZShvcmlnaW5hbE1haW4sICdodHRwIHtcbicsICdodHRwIHtcbicgKyBtYXApOwogIGNvbnN0IGdhdGUgPSBibG9jaygnR0FURScsICcgICAgICAgIGVycm9yX3BhZ2UgNDE4ID0gQG1hdHRlcl9kcml2ZXJfcmVwb3J0c19jYW5hcnk7XG4nCiAgICArICcgICAgICAgIGlmICgkbWF0dGVyX2RyaXZlcl9yZXBvcnRzX2NhbmFyeSA9IDEpIHsgcmV0dXJuIDQxODsgfVxuJywgJyAgICAgICAgJyk7CiAgbGV0IHNlYWxlZFNpdGUgPSBvbmNlKG9yaWdpbmFsU2l0ZSwgJyAgICBsb2NhdGlvbiAvIHtcbicsICcgICAgbG9jYXRpb24gLyB7XG4nICsgZ2F0ZSk7CiAgc2VhbGVkU2l0ZSA9IG9uY2Uoc2VhbGVkU2l0ZSwgJyAgICBsb2NhdGlvbiAvYXBpLyB7XG4nLCAnICAgIGxvY2F0aW9uIC9hcGkvIHtcbicgKyBnYXRlKTsKICBjb25zdCBhcGkgPSBvcmlnaW5hbFNpdGUuc3BsaXQoJyAgICBsb2NhdGlvbiAvYXBpLyB7XG4nKVsxXT8uc3BsaXQoJ1xuICAgIH1cbicpWzBdOwogIG5lZWQoYXBpPy5pbmNsdWRlcygncHJveHlfcGFzcyBodHRwOi8vMTI3LjAuMC4xOjUwMDAvYXBpLzsnKSk7CiAgY29uc3QgcHJveHlIZWFkZXJzID0gYXBpLnNwbGl0KCdcbicpLmZpbHRlcihsaW5lID0+IC9eICAgICAgICBwcm94eV8oPzpodHRwX3ZlcnNpb258c2V0X2hlYWRlcnxjYWNoZV9ieXBhc3MpIC8udGVzdChsaW5lKSkuam9pbignXG4nKTsKICBuZWVkKHByb3h5SGVhZGVycy5pbmNsdWRlcygncHJveHlfc2V0X2hlYWRlciBIb3N0ICRob3N0OycpICYmIHByb3h5SGVhZGVycy5pbmNsdWRlcygncHJveHlfc2V0X2hlYWRlciBYLUZvcndhcmRlZC1Qcm90byAkc2NoZW1lOycpKTsKICAvLyBBIG5hbWVkIGVycm9yIHJlZGlyZWN0IHByZXNlcnZlcyBQT1NUL1VSSTsgcHJveHlfcGFzcyB3aXRob3V0IGEgVVJJIGtlZXBzCiAgLy8gdGhlIG9yaWdpbmFsIGZ1bGwgcGF0aCBhbmQgYXJndW1lbnRzLiBObyByZWdleCBsb2NhdGlvbiBvciB2YXJpYWJsZSBVUkkuCiAgLy8gaHR0cHM6Ly9uZ2lueC5vcmcvZW4vZG9jcy9odHRwL25neF9odHRwX2NvcmVfbW9kdWxlLmh0bWwjZXJyb3JfcGFnZQogIC8vIGh0dHBzOi8vbmdpbngub3JnL2VuL2RvY3MvaHR0cC9uZ3hfaHR0cF9wcm94eV9tb2R1bGUuaHRtbCNwcm94eV9wYXNzCiAgY29uc3QgcHJveHkgPSBibG9jaygnUFJPWFknLCAnICAgIGxvY2F0aW9uIEBtYXR0ZXJfZHJpdmVyX3JlcG9ydHNfY2FuYXJ5IHtcbicKICAgICsgJyAgICAgICAgcHJveHlfcGFzcyBodHRwOi8vMTI3LjAuMC4xOjUwMDI7XG4nICsgcHJveHlIZWFkZXJzICsgJ1xuICAgIH1cbicsICcgICAgJyk7CiAgbmVlZChzZWFsZWRTaXRlLmVuZHNXaXRoKCd9XG4nKSk7IHNlYWxlZFNpdGUgPSBzZWFsZWRTaXRlLnNsaWNlKDAsIC0yKSArIHByb3h5ICsgJ31cbic7CiAgY29uc3QgaW5oZXJpdGVkSGVhZGVycyA9IG9yaWdpbmFsU2l0ZS5zbGljZSgwLCBvcmlnaW5hbFNpdGUuaW5kZXhPZignICAgIGxvY2F0aW9uIC8ge1xuJykpLnNwbGl0KCdcbicpCiAgICAuZmlsdGVyKGxpbmUgPT4gL14gICAgYWRkX2hlYWRlciAvLnRlc3QobGluZSkpLm1hcChsaW5lID0+ICcgICAgJyArIGxpbmUpLmpvaW4oJ1xuJyk7CiAgbmVlZChpbmhlcml0ZWRIZWFkZXJzLmluY2x1ZGVzKCdYLUZyYW1lLU9wdGlvbnMnKSAmJiBpbmhlcml0ZWRIZWFkZXJzLmluY2x1ZGVzKCdTdHJpY3QtVHJhbnNwb3J0LVNlY3VyaXR5JykpOwogIC8vIGFkZF9oZWFkZXIgb24gdGhlIGVudHJ5IGRpc2FibGVzIG9yZGluYXJ5IGluaGVyaXRlZCBoZWFkZXJzOyByZXBlYXQgdGhlCiAgLy8gZXhhY3Qgc2VydmVyIGRpcmVjdGl2ZXMgdGhlcmUsIHByZXNlcnZpbmcgdGhlIGluc3BlY3RlZCBzZWN1cml0eSBwb2xpY3kuCiAgLy8gaHR0cHM6Ly9uZ2lueC5vcmcvZW4vZG9jcy9odHRwL25neF9odHRwX2hlYWRlcnNfbW9kdWxlLmh0bWwjYWRkX2hlYWRlcgogIGNvbnN0IGVudHJ5UGF0aCA9ICcvX21hdHRlci1kcml2ZXItcmVwb3J0cy1jYW5hcnkvJyArIGVudHJ5Tm9uY2U7CiAgY29uc3QgZW50cnkgPSBibG9jaygnRU5UUlknLCAnICAgIGxvY2F0aW9uID0gJyArIGVudHJ5UGF0aCArICcge1xuJwogICAgKyAnICAgICAgICBpZiAoJHJlcXVlc3RfbWV0aG9kICE9IEdFVCkgeyByZXR1cm4gNDA0OyB9XG4nCiAgICArICcgICAgICAgIGlmICgkbWF0dGVyX2RyaXZlcl9yZXBvcnRzX2NhbmFyeV9lbnRyeSAhPSAxKSB7IHJldHVybiA0MDQ7IH1cbicgKyBpbmhlcml0ZWRIZWFkZXJzICsgJ1xuJwogICAgKyAnICAgICAgICBhZGRfaGVhZGVyIFNldC1Db29raWUgIm1hdHRlcl9kcml2ZXJfcmVwb3J0c19jYW5hcnk9JyArIHNlbGVjdG9yICsgJzsgUGF0aD0vOyBNYXgtQWdlPScgKyB0dGxTZWNvbmRzICsgJzsgU2VjdXJlOyBIdHRwT25seTsgU2FtZVNpdGU9U3RyaWN0IiBhbHdheXM7XG4nCiAgICArICcgICAgICAgIGFkZF9oZWFkZXIgQ2FjaGUtQ29udHJvbCAibm8tc3RvcmUiIGFsd2F5cztcbiAgICAgICAgYWRkX2hlYWRlciBSZWZlcnJlci1Qb2xpY3kgIm5vLXJlZmVycmVyIiBhbHdheXM7XG4nCiAgICArICcgICAgICAgIHJldHVybiAzMDMgL2RyaXZlci1yZXBvcnRzO1xuICAgIH1cbicsICcgICAgJyk7CiAgY29uc3QgZW5hYmxlZFNpdGUgPSBzZWFsZWRTaXRlLnNsaWNlKDAsIC0yKSArIGVudHJ5ICsgJ31cbic7CiAgY29uc3QgdmFsdWUgPSB7IHZlcnNpb246IDEsIGtpbmQ6ICdzdXBhYmFzZS1icm93c2VyLWNhbmFyeS1wbGFuLXYxJywgaXNzdWVkQXQsIGV4cGlyZXNBdCwgdHRsU2Vjb25kcywgc2VsZWN0b3IsIGVudHJ5Tm9uY2UsIGVudHJ5UGF0aCwKICAgIGJlZm9yZTogeyBtYWluOiBtYWluLnRvU3RyaW5nKCdiYXNlNjQnKSwgc2l0ZTogc2l0ZS50b1N0cmluZygnYmFzZTY0JykgfSwKICAgIGVuYWJsZWQ6IHsgbWFpbjogQnVmZmVyLmZyb20oZW5hYmxlZE1haW4pLnRvU3RyaW5nKCdiYXNlNjQnKSwgc2l0ZTogQnVmZmVyLmZyb20oZW5hYmxlZFNpdGUpLnRvU3RyaW5nKCdiYXNlNjQnKSB9LAogICAgc2VhbGVkOiB7IG1haW46IEJ1ZmZlci5mcm9tKGVuYWJsZWRNYWluKS50b1N0cmluZygnYmFzZTY0JyksIHNpdGU6IEJ1ZmZlci5mcm9tKHNlYWxlZFNpdGUpLnRvU3RyaW5nKCdiYXNlNjQnKSB9IH07CiAgcmV0dXJuIHsgLi4udmFsdWUsIHBsYW5TaGEyNTY6IHNoYShKU09OLnN0cmluZ2lmeSh2YWx1ZSkpIH07Cn0KCmV4cG9ydCBmdW5jdGlvbiBkcml2ZXJBdWRpdFN1cGFiYXNlQ2FuYXJ5RGlmZihwbGFuKSB7CiAgcmV0dXJuIE9iamVjdC5rZXlzKGZpbGVzKS5tYXAobmFtZSA9PiB7CiAgICBjb25zdCBiZWZvcmUgPSBkZWNvZGUocGxhbi5iZWZvcmVbbmFtZV0pLnRvU3RyaW5nKCkuc3BsaXQoJ1xuJyksIGFmdGVyID0gZGVjb2RlKHBsYW4uZW5hYmxlZFtuYW1lXSkudG9TdHJpbmcoKS5zcGxpdCgnXG4nKTsKICAgIGxldCBhID0gMCwgYiA9IDA7CiAgICB3aGlsZSAoYSA8IGJlZm9yZS5sZW5ndGggJiYgYmVmb3JlW2FdID09PSBhZnRlclthXSkgYSsrOwogICAgd2hpbGUgKGIgPCBiZWZvcmUubGVuZ3RoIC0gYSAmJiBiZWZvcmVbYmVmb3JlLmxlbmd0aCAtIDEgLSBiXSA9PT0gYWZ0ZXJbYWZ0ZXIubGVuZ3RoIC0gMSAtIGJdKSBiKys7CiAgICByZXR1cm4gJy0tLSAnICsgZmlsZXNbbmFtZV0gKyAnXG4rKysgJyArIGZpbGVzW25hbWVdICsgJ1xuQEAgLScgKyAoYSArIDEpICsgJywnICsgKGJlZm9yZS5sZW5ndGggLSBhIC0gYikKICAgICAgKyAnICsnICsgKGEgKyAxKSArICcsJyArIChhZnRlci5sZW5ndGggLSBhIC0gYikgKyAnIEBAXG4nCiAgICAgICsgYmVmb3JlLnNsaWNlKGEsIGJlZm9yZS5sZW5ndGggLSBiKS5tYXAobGluZSA9PiAnLScgKyBsaW5lKS5qb2luKCdcbicpICsgJ1xuJwogICAgICArIGFmdGVyLnNsaWNlKGEsIGFmdGVyLmxlbmd0aCAtIGIpLm1hcChsaW5lID0+ICcrJyArIGxpbmUpLmpvaW4oJ1xuJykgKyAnXG4nOwogIH0pLmpvaW4oJ1xuJyk7Cn0KCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlRHJpdmVyQXVkaXRTdXBhYmFzZUNhbmFyeSh7IG9wZXJhdGlvbiwgcGxhbiB9LCBleGVjdXRvciA9IGNyZWF0ZURyaXZlckF1ZGl0U3VwYWJhc2VDYW5hcnlFeGVjdXRvcigpKSB7CiAgbmVlZChbJ2VuYWJsZScsICdzZWFsLWVudHJ5JywgJ3Jlc3RvcmUnXS5pbmNsdWRlcyhvcGVyYXRpb24pKTsKICBjb25zdCB2ZXJpZmllZCA9IGNyZWF0ZURyaXZlckF1ZGl0U3VwYWJhc2VDYW5hcnlQbGFuKHsgbWFpbjogZGVjb2RlKHBsYW4uYmVmb3JlLm1haW4pLCBzaXRlOiBkZWNvZGUocGxhbi5iZWZvcmUuc2l0ZSksCiAgICBzZWxlY3RvcjogcGxhbi5zZWxlY3RvciwgZW50cnlOb25jZTogcGxhbi5lbnRyeU5vbmNlLCBpc3N1ZWRBdDogcGxhbi5pc3N1ZWRBdCwgdHRsU2Vjb25kczogcGxhbi50dGxTZWNvbmRzIH0sIHsgaGFzaGVzOiBleGVjdXRvci5oYXNoZXMgPz8gaGFzaGVzIH0pOwogIG5lZWQoSlNPTi5zdHJpbmdpZnkodmVyaWZpZWQpID09PSBKU09OLnN0cmluZ2lmeShwbGFuKSk7CiAgaWYgKG9wZXJhdGlvbiA9PT0gJ2VuYWJsZScpIG5lZWQoRGF0ZS5wYXJzZShwbGFuLmlzc3VlZEF0KSA8PSBleGVjdXRvci5ub3coKSAmJiBleGVjdXRvci5ub3coKSA8IERhdGUucGFyc2UocGxhbi5leHBpcmVzQXQpKTsKICByZXR1cm4gZXhlY3V0b3Iud2l0aExvY2soYXN5bmMgKCkgPT4gewogICAgY29uc3Qga25vd24gPSBuYW1lID0+IFsnYmVmb3JlJywgJ2VuYWJsZWQnLCAnc2VhbGVkJ10ubWFwKHBoYXNlID0+IHNoYShkZWNvZGUocGxhbltwaGFzZV1bbmFtZV0pKSk7CiAgICBjb25zdCByZWFkS25vd24gPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yLnJlYWQoKTsKICAgICAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKGZpbGVzKSkgbmVlZChrbm93bihuYW1lKS5pbmNsdWRlcyhyZXN1bHRbbmFtZV0uc2hhMjU2KSk7CiAgICAgIHJldHVybiByZXN1bHQ7CiAgICB9OwogICAgY29uc3QgaW5pdGlhbCA9IGF3YWl0IHJlYWRLbm93bigpLCBpc09yaWdpbmFsID0gT2JqZWN0LmtleXMoZmlsZXMpLmV2ZXJ5KG5hbWUgPT4gaW5pdGlhbFtuYW1lXS5zaGEyNTYgPT09IHNoYShkZWNvZGUocGxhbi5iZWZvcmVbbmFtZV0pKSk7CiAgICBuZWVkKG9wZXJhdGlvbiAhPT0gJ3NlYWwtZW50cnknIHx8ICFpc09yaWdpbmFsKTsKICAgIGNvbnN0IGJhY2t1cCA9IGF3YWl0IGV4ZWN1dG9yLmJhY2t1cChwbGFuLCBpc09yaWdpbmFsKTsKICAgIGNvbnN0IHZlcmlmeVZhcmlhbnQgPSBhc3luYyB2YXJpYW50ID0+IHsKICAgICAgY29uc3QgYWZ0ZXIgPSBhd2FpdCBleGVjdXRvci5yZWFkKCk7CiAgICAgIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyhmaWxlcykpIG5lZWQoYWZ0ZXJbbmFtZV0uc2hhMjU2ID09PSBzaGEoZGVjb2RlKHBsYW5bdmFyaWFudF1bbmFtZV0pKQogICAgICAgICYmIGFmdGVyW25hbWVdLm1vZGUgPT09ICh2YXJpYW50ID09PSAnYmVmb3JlJyA/IGJhY2t1cC5tb2Rlc1tuYW1lXSA6IDBvNjAwKSk7CiAgICB9OwogICAgY29uc3Qgd3JpdGVWYXJpYW50ID0gYXN5bmMgdmFyaWFudCA9PiB7CiAgICAgIGNvbnN0IGJlZm9yZSA9IGF3YWl0IHJlYWRLbm93bigpOwogICAgICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoZmlsZXMpKSB7CiAgICAgICAgY29uc3QgYnl0ZXMgPSBkZWNvZGUocGxhblt2YXJpYW50XVtuYW1lXSksIG1vZGUgPSB2YXJpYW50ID09PSAnYmVmb3JlJyA/IGJhY2t1cC5tb2Rlc1tuYW1lXSA6IDBvNjAwOwogICAgICAgIGlmIChiZWZvcmVbbmFtZV0uc2hhMjU2ICE9PSBzaGEoYnl0ZXMpIHx8IGJlZm9yZVtuYW1lXS5tb2RlICE9PSBtb2RlKSBhd2FpdCBleGVjdXRvci5yZXBsYWNlKG5hbWUsIGJlZm9yZVtuYW1lXSwgYnl0ZXMsIG1vZGUpOwogICAgICB9CiAgICAgIGF3YWl0IHZlcmlmeVZhcmlhbnQodmFyaWFudCk7CiAgICB9OwogICAgY29uc3QgdmVyaWZ5QW5kUmVsb2FkID0gYXN5bmMgdmFyaWFudCA9PiB7CiAgICAgIGF3YWl0IGV4ZWN1dG9yLnRlc3QoKTsgYXdhaXQgdmVyaWZ5VmFyaWFudCh2YXJpYW50KTsgYXdhaXQgZXhlY3V0b3IucmVsb2FkKCk7IGF3YWl0IHZlcmlmeVZhcmlhbnQodmFyaWFudCk7CiAgICB9OwogICAgdHJ5IHsKICAgICAgY29uc3QgdmFyaWFudCA9IG9wZXJhdGlvbiA9PT0gJ2VuYWJsZScgPyAnZW5hYmxlZCcgOiBvcGVyYXRpb24gPT09ICdzZWFsLWVudHJ5JyA/ICdzZWFsZWQnIDogJ2JlZm9yZSc7CiAgICAgIGF3YWl0IHdyaXRlVmFyaWFudCh2YXJpYW50KTsgYXdhaXQgdmVyaWZ5QW5kUmVsb2FkKHZhcmlhbnQpOwogICAgICByZXR1cm4geyBzdGF0dXM6IG9wZXJhdGlvbiwgcGxhblNoYTI1NjogcGxhbi5wbGFuU2hhMjU2LCBleHBpcmVzQXQ6IHBsYW4uZXhwaXJlc0F0LCBlbnRyeVNlYWxlZDogb3BlcmF0aW9uICE9PSAnZW5hYmxlJywKICAgICAgICBhdXRoR3JhbnRlZDogZmFsc2UsIGRlZmF1bHRSb3V0aW5nQ2hhbmdlZDogZmFsc2UsIHJlbG9hZFJlcXVlc3RlZDogdHJ1ZSwgbGl2ZVJvdXRpbmdWZXJpZmllZDogZmFsc2UgfTsKICAgIH0gY2F0Y2ggewogICAgICBsZXQgcmVzdG9yZWQgPSBmYWxzZTsKICAgICAgdHJ5IHsgYXdhaXQgd3JpdGVWYXJpYW50KCdiZWZvcmUnKTsgYXdhaXQgdmVyaWZ5QW5kUmVsb2FkKCdiZWZvcmUnKTsgcmVzdG9yZWQgPSB0cnVlOyB9IGNhdGNoIHsgLyogUHJlc2VydmUgaW5kZXBlbmRlbnQgZWRpdHMgYW5kIHByaXZhdGUgYmFja3VwLiAqLyB9CiAgICAgIHRocm93IE9iamVjdC5hc3NpZ24oRXJyb3IoJ0RyaXZlciBSZXBvcnRzIGNhbmFyeSBjaGFuZ2Ugc3RvcHBlZCcpLCB7IHJvbGxiYWNrUmVzdG9yZWQ6IHJlc3RvcmVkLCByb2xsYmFja0Jsb2NrZWQ6ICFyZXN0b3JlZCB9KTsKICAgIH0KICB9KTsKfQoKLy8gVGhpcyBleGVjdXRvciBoYXMgbm8gY29uZmlndXJhYmxlIGZpbGUsIGNvbW1hbmQsIHByb2ZpbGUsIGVudmlyb25tZW50IG9yIHBvcnQuCi8vIEFkYXB0ZXJzIGFyZSBleGNsdXNpdmVseSBhIGxvY2FsIHRlc3QgYm91bmRhcnkuIExpdmUgbXV0YXRpb24gcmVxdWlyZXMgVUlEMC4KZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZURyaXZlckF1ZGl0U3VwYWJhc2VDYW5hcnlFeGVjdXRvcihhZGFwdGVycyA9IHt9KSB7CiAgY29uc3QgaW8gPSBhZGFwdGVycy5maWxlc3lzdGVtID8/IGZzLCB1aWQgPSBhZGFwdGVycy51aWQgPz8gKCgpID0+IHByb2Nlc3MuZ2V0dWlkKCkpLCBwbGF0Zm9ybSA9IGFkYXB0ZXJzLnBsYXRmb3JtID8/IHByb2Nlc3MucGxhdGZvcm07CiAgY29uc3QgY29tbWFuZCA9IGFkYXB0ZXJzLmV4ZWMgPz8gcHJvbWlzaWZ5KGV4ZWNGaWxlKTsKICBjb25zdCByb290ID0gKCkgPT4gbmVlZCh1aWQoKSA9PT0gMCAmJiBwbGF0Zm9ybSA9PT0gJ2xpbnV4Jyk7CiAgY29uc3QgZGlyZWN0b3J5ID0gYXN5bmMgKGZvbGRlciwgcHJpdmF0ZU1vZGUgPSBmYWxzZSkgPT4gewogICAgY29uc3Qgc3RhdCA9IGF3YWl0IGlvLmxzdGF0KGZvbGRlciwgeyBiaWdpbnQ6IHRydWUgfSk7CiAgICBuZWVkKHN0YXQuaXNEaXJlY3RvcnkoKSAmJiBzdGF0LnVpZCA9PT0gMG4gJiYgIShOdW1iZXIoc3RhdC5tb2RlKSAmIChwcml2YXRlTW9kZSA/IDBvMDc3IDogMG8wMjIpKSAmJiBhd2FpdCBpby5yZWFscGF0aChmb2xkZXIpID09PSBmb2xkZXIpOwogICAgcmV0dXJuIHN0YXQ7CiAgfTsKICBjb25zdCByZWFkID0gYXN5bmMgKGZpbGUsIHByaXZhdGVNb2RlID0gZmFsc2UpID0+IHsKICAgIGNvbnN0IGJlZm9yZSA9IGF3YWl0IGlvLmxzdGF0KGZpbGUsIHsgYmlnaW50OiB0cnVlIH0pOwogICAgbmVlZChiZWZvcmUuaXNGaWxlKCkgJiYgYmVmb3JlLnVpZCA9PT0gMG4gJiYgIShOdW1iZXIoYmVmb3JlLm1vZGUpICYgKHByaXZhdGVNb2RlID8gMG8wNzcgOiAwbzAyMikpCiAgICAgICYmIGJlZm9yZS5zaXplID4gMG4gJiYgYmVmb3JlLnNpemUgPD0gMTI4biAqIDEwMjRuICYmIGF3YWl0IGlvLnJlYWxwYXRoKGZpbGUpID09PSBmaWxlKTsKICAgIGNvbnN0IGhhbmRsZSA9IGF3YWl0IGlvLm9wZW4oZmlsZSwgY29uc3RhbnRzLk9fUkRPTkxZIHwgY29uc3RhbnRzLk9fTk9GT0xMT1cgfCBjb25zdGFudHMuT19OT05CTE9DSyk7CiAgICB0cnkgewogICAgICBuZWVkKHNpZ25hdHVyZShhd2FpdCBoYW5kbGUuc3RhdCh7IGJpZ2ludDogdHJ1ZSB9KSkgPT09IHNpZ25hdHVyZShiZWZvcmUpKTsKICAgICAgY29uc3QgYnl0ZXMgPSBCdWZmZXIuYWxsb2MoTnVtYmVyKGJlZm9yZS5zaXplKSk7CiAgICAgIGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8IGJ5dGVzLmxlbmd0aDspIHsKICAgICAgICBjb25zdCB7IGJ5dGVzUmVhZCB9ID0gYXdhaXQgaGFuZGxlLnJlYWQoYnl0ZXMsIG9mZnNldCwgYnl0ZXMubGVuZ3RoIC0gb2Zmc2V0LCBvZmZzZXQpOyBuZWVkKGJ5dGVzUmVhZCA+IDApOyBvZmZzZXQgKz0gYnl0ZXNSZWFkOwogICAgICB9CiAgICAgIG5lZWQoKGF3YWl0IGhhbmRsZS5yZWFkKEJ1ZmZlci5hbGxvYygxKSwgMCwgMSwgYnl0ZXMubGVuZ3RoKSkuYnl0ZXNSZWFkID09PSAwCiAgICAgICAgJiYgc2lnbmF0dXJlKGF3YWl0IGhhbmRsZS5zdGF0KHsgYmlnaW50OiB0cnVlIH0pKSA9PT0gc2lnbmF0dXJlKGJlZm9yZSkKICAgICAgICAmJiBzaWduYXR1cmUoYXdhaXQgaW8ubHN0YXQoZmlsZSwgeyBiaWdpbnQ6IHRydWUgfSkpID09PSBzaWduYXR1cmUoYmVmb3JlKSAmJiBhd2FpdCBpby5yZWFscGF0aChmaWxlKSA9PT0gZmlsZSk7CiAgICAgIHJldHVybiB7IGJ5dGVzLCBzaGEyNTY6IHNoYShieXRlcyksIG1vZGU6IE51bWJlcihiZWZvcmUubW9kZSkgJiAwbzc3NywgZ2lkOiBOdW1iZXIoYmVmb3JlLmdpZCksIHNpZ25hdHVyZTogc2lnbmF0dXJlKGJlZm9yZSkgfTsKICAgIH0gZmluYWxseSB7IGF3YWl0IGhhbmRsZS5jbG9zZSgpOyB9CiAgfTsKICBjb25zdCBwb2ludGVyID0gYXN5bmMgKCkgPT4gewogICAgZm9yIChjb25zdCBmb2xkZXIgb2YgWycvZXRjL25naW54JywgJy9ldGMvbmdpbngvc2l0ZXMtZW5hYmxlZCcsICcvZXRjL25naW54L3NpdGVzLWF2YWlsYWJsZSddKSBhd2FpdCBkaXJlY3RvcnkoZm9sZGVyKTsKICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBpby5sc3RhdChsaW5rLCB7IGJpZ2ludDogdHJ1ZSB9KSwgdGFyZ2V0ID0gYXdhaXQgaW8ucmVhZGxpbmsobGluayk7CiAgICBuZWVkKHN0YXQuaXNTeW1ib2xpY0xpbmsoKSAmJiBzdGF0LnVpZCA9PT0gMG4gJiYgWycuLi9zaXRlcy1hdmFpbGFibGUvbWF0dGVyJywgZmlsZXMuc2l0ZV0uaW5jbHVkZXModGFyZ2V0KSAmJiBhd2FpdCBpby5yZWFscGF0aChsaW5rKSA9PT0gZmlsZXMuc2l0ZSk7CiAgICByZXR1cm4geyBzaWduYXR1cmU6IHNpZ25hdHVyZShzdGF0KSwgdGFyZ2V0IH07CiAgfTsKICBjb25zdCBzeW5jRGlyZWN0b3J5ID0gYXN5bmMgZm9sZGVyID0+IHsKICAgIGNvbnN0IGJlZm9yZSA9IGF3YWl0IGRpcmVjdG9yeShmb2xkZXIpLCBoYW5kbGUgPSBhd2FpdCBpby5vcGVuKGZvbGRlciwgY29uc3RhbnRzLk9fUkRPTkxZIHwgY29uc3RhbnRzLk9fRElSRUNUT1JZIHwgY29uc3RhbnRzLk9fTk9GT0xMT1cpOwogICAgdHJ5IHsKICAgICAgbmVlZChpZGVudGl0eShhd2FpdCBoYW5kbGUuc3RhdCh7IGJpZ2ludDogdHJ1ZSB9KSkgPT09IGlkZW50aXR5KGJlZm9yZSkpOyBhd2FpdCBoYW5kbGUuc3luYygpOwogICAgICBuZWVkKGlkZW50aXR5KGF3YWl0IGlvLmxzdGF0KGZvbGRlciwgeyBiaWdpbnQ6IHRydWUgfSkpID09PSBpZGVudGl0eShiZWZvcmUpICYmIGF3YWl0IGlvLnJlYWxwYXRoKGZvbGRlcikgPT09IGZvbGRlcik7CiAgICB9IGZpbmFsbHkgeyBhd2FpdCBoYW5kbGUuY2xvc2UoKTsgfQogIH07CiAgY29uc3QgYXRvbWljID0gYXN5bmMgKGZpbGUsIGJ5dGVzLCBtb2RlLCBleHBlY3RlZCwgZ2lkID0gMCkgPT4gewogICAgcm9vdCgpOyBuZWVkKEJ1ZmZlci5pc0J1ZmZlcihieXRlcykgJiYgYnl0ZXMubGVuZ3RoIDw9IDEyOCAqIDEwMjQgJiYgTnVtYmVyLmlzSW50ZWdlcihtb2RlKSAmJiAhKG1vZGUgJiB+MG83NzcpICYmICEobW9kZSAmIDBvMDIyKSk7CiAgICBjb25zdCBmb2xkZXIgPSBwYXRoLmRpcm5hbWUoZmlsZSksIGJlZm9yZSA9IGF3YWl0IGRpcmVjdG9yeShmb2xkZXIpLCBoYW5kbGUgPSBhd2FpdCBpby5vcGVuKGZvbGRlciwgY29uc3RhbnRzLk9fUkRPTkxZIHwgY29uc3RhbnRzLk9fRElSRUNUT1JZIHwgY29uc3RhbnRzLk9fTk9GT0xMT1cpOwogICAgY29uc3QgYW5jaG9yZWQgPSAnL3Byb2Mvc2VsZi9mZC8nICsgaGFuZGxlLmZkOwogICAgY29uc3QgdGVtcG9yYXJ5ID0gcGF0aC5qb2luKGFuY2hvcmVkLCAnLm1hdHRlci1jYW5hcnktJyArIHJhbmRvbVVVSUQoKSArICcudG1wJyk7IGxldCBjcmVhdGVkID0gZmFsc2U7CiAgICB0cnkgewogICAgICBuZWVkKGlkZW50aXR5KGF3YWl0IGhhbmRsZS5zdGF0KHsgYmlnaW50OiB0cnVlIH0pKSA9PT0gaWRlbnRpdHkoYmVmb3JlKSk7CiAgICAgIGlmIChleHBlY3RlZCkgbmVlZCgoYXdhaXQgcmVhZChmaWxlKSkuc2lnbmF0dXJlID09PSBleHBlY3RlZC5zaWduYXR1cmUpOwogICAgICBjb25zdCB0ZW1wID0gYXdhaXQgaW8ub3Blbih0ZW1wb3JhcnksIGNvbnN0YW50cy5PX1dST05MWSB8IGNvbnN0YW50cy5PX0NSRUFUIHwgY29uc3RhbnRzLk9fRVhDTCB8IGNvbnN0YW50cy5PX05PRk9MTE9XLCAwbzYwMCk7IGNyZWF0ZWQgPSB0cnVlOwogICAgICB0cnkgeyBhd2FpdCB0ZW1wLndyaXRlRmlsZShieXRlcyk7IGF3YWl0IHRlbXAuY2hvd24oMCwgZ2lkKTsgYXdhaXQgdGVtcC5jaG1vZChtb2RlKTsgYXdhaXQgdGVtcC5zeW5jKCk7IH0gZmluYWxseSB7IGF3YWl0IHRlbXAuY2xvc2UoKTsgfQogICAgICBuZWVkKGlkZW50aXR5KGF3YWl0IGlvLmxzdGF0KGZvbGRlciwgeyBiaWdpbnQ6IHRydWUgfSkpID09PSBpZGVudGl0eShiZWZvcmUpICYmIGF3YWl0IGlvLnJlYWxwYXRoKGZvbGRlcikgPT09IGZvbGRlcik7CiAgICAgIGlmIChleHBlY3RlZCkgbmVlZCgoYXdhaXQgcmVhZChmaWxlKSkuc2lnbmF0dXJlID09PSBleHBlY3RlZC5zaWduYXR1cmUpOwogICAgICBhd2FpdCBpby5yZW5hbWUodGVtcG9yYXJ5LCBwYXRoLmpvaW4oYW5jaG9yZWQsIHBhdGguYmFzZW5hbWUoZmlsZSkpKTsgY3JlYXRlZCA9IGZhbHNlOyBhd2FpdCBoYW5kbGUuc3luYygpOwogICAgICBuZWVkKChhd2FpdCByZWFkKGZpbGUpKS5zaGEyNTYgPT09IHNoYShieXRlcykgJiYgaWRlbnRpdHkoYXdhaXQgaW8ubHN0YXQoZm9sZGVyLCB7IGJpZ2ludDogdHJ1ZSB9KSkgPT09IGlkZW50aXR5KGJlZm9yZSkpOwogICAgfSBmaW5hbGx5IHsgaWYgKGNyZWF0ZWQpIGF3YWl0IGlvLnVubGluayh0ZW1wb3JhcnkpOyBhd2FpdCBoYW5kbGUuY2xvc2UoKTsgfQogIH07CiAgcmV0dXJuIHsgaGFzaGVzLCBub3c6ICgpID0+IERhdGUubm93KCksCiAgICBhc3luYyByZWFkKCkgewogICAgICBjb25zdCBiZWZvcmUgPSBhd2FpdCBwb2ludGVyKCksIG1haW4gPSBhd2FpdCByZWFkKGZpbGVzLm1haW4pLCBzaXRlID0gYXdhaXQgcmVhZChmaWxlcy5zaXRlKTsKICAgICAgbmVlZChKU09OLnN0cmluZ2lmeShhd2FpdCBwb2ludGVyKCkpID09PSBKU09OLnN0cmluZ2lmeShiZWZvcmUpKTsgcmV0dXJuIHsgbWFpbiwgc2l0ZSB9OwogICAgfSwKICAgIGFzeW5jIHdpdGhMb2NrKG9wZXJhdGlvbikgewogICAgICByb290KCk7IGF3YWl0IGRpcmVjdG9yeSgnL3Zhci9saWInKTsKICAgICAgYXdhaXQgaW8ubWtkaXIoc3RvcmFnZSwgeyBtb2RlOiAwbzcwMCB9KS5jYXRjaChlcnJvciA9PiB7IGlmIChlcnJvci5jb2RlICE9PSAnRUVYSVNUJykgdGhyb3cgZXJyb3I7IH0pOyBhd2FpdCBkaXJlY3Rvcnkoc3RvcmFnZSwgdHJ1ZSk7CiAgICAgIGF3YWl0IHN5bmNEaXJlY3RvcnkoJy92YXIvbGliJyk7CiAgICAgIGNvbnN0IGZpbGUgPSBwYXRoLmpvaW4oc3RvcmFnZSwgJ29wZXJhdG9yLmxvY2snKSwgaGFuZGxlID0gYXdhaXQgaW8ub3BlbihmaWxlLCAnd3gnLCAwbzYwMCk7CiAgICAgIGNvbnN0IGxvY2tlZCA9IGlkZW50aXR5KGF3YWl0IGhhbmRsZS5zdGF0KHsgYmlnaW50OiB0cnVlIH0pKTsKICAgICAgdHJ5IHsgcmV0dXJuIGF3YWl0IG9wZXJhdGlvbigpOyB9CiAgICAgIGZpbmFsbHkgewogICAgICAgIHRyeSB7IGF3YWl0IGhhbmRsZS5jbG9zZSgpOyB9CiAgICAgICAgZmluYWxseSB7IG5lZWQoaWRlbnRpdHkoYXdhaXQgaW8ubHN0YXQoZmlsZSwgeyBiaWdpbnQ6IHRydWUgfSkpID09PSBsb2NrZWQpOyBhd2FpdCBpby51bmxpbmsoZmlsZSk7IH0KICAgICAgfQogICAgfSwKICAgIGFzeW5jIGJhY2t1cChwbGFuLCBtYXlDcmVhdGUpIHsKICAgICAgcm9vdCgpOyBuZWVkKC9eW2EtZjAtOV17NjR9JC8udGVzdChwbGFuLnBsYW5TaGEyNTYpKTsgY29uc3QgZmlsZSA9IHBhdGguam9pbihzdG9yYWdlLCBwbGFuLnBsYW5TaGEyNTYgKyAnLmpzb24nKTsKICAgICAgbGV0IHNhdmVkID0gYXdhaXQgcmVhZChmaWxlLCB0cnVlKS5jYXRjaChlcnJvciA9PiB7IGlmIChlcnJvci5jb2RlID09PSAnRU5PRU5UJykgcmV0dXJuIG51bGw7IHRocm93IGVycm9yOyB9KTsKICAgICAgaWYgKCFzYXZlZCkgewogICAgICAgIG5lZWQobWF5Q3JlYXRlKTsgY29uc3QgY3VycmVudCA9IHsgbWFpbjogYXdhaXQgcmVhZChmaWxlcy5tYWluKSwgc2l0ZTogYXdhaXQgcmVhZChmaWxlcy5zaXRlKSB9LCBtb2RlcyA9IHt9OwogICAgICAgIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyhmaWxlcykpIHsgbmVlZChjdXJyZW50W25hbWVdLmJ5dGVzLmVxdWFscyhkZWNvZGUocGxhbi5iZWZvcmVbbmFtZV0pKSk7IG1vZGVzW25hbWVdID0gY3VycmVudFtuYW1lXS5tb2RlOyB9CiAgICAgICAgY29uc3QgYnl0ZXMgPSBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeSh7IHZlcnNpb246IDEsIHBsYW4sIG1vZGVzLCBwb2ludGVyOiBhd2FpdCBwb2ludGVyKCkgfSkpOwogICAgICAgIG5lZWQoYnl0ZXMubGVuZ3RoIDw9IDEyOCAqIDEwMjQpOyBjb25zdCBoYW5kbGUgPSBhd2FpdCBpby5vcGVuKGZpbGUsICd3eCcsIDBvNjAwKTsKICAgICAgICB0cnkgeyBhd2FpdCBoYW5kbGUud3JpdGVGaWxlKGJ5dGVzKTsgYXdhaXQgaGFuZGxlLnN5bmMoKTsgfSBmaW5hbGx5IHsgYXdhaXQgaGFuZGxlLmNsb3NlKCk7IH0KICAgICAgICBzYXZlZCA9IGF3YWl0IHJlYWQoZmlsZSwgdHJ1ZSk7CiAgICAgIH0KICAgICAgYXdhaXQgc3luY0RpcmVjdG9yeShzdG9yYWdlKTsKICAgICAgY29uc3QgdmFsdWUgPSBKU09OLnBhcnNlKHNhdmVkLmJ5dGVzKTsgbmVlZChKU09OLnN0cmluZ2lmeSh2YWx1ZS5wbGFuKSA9PT0gSlNPTi5zdHJpbmdpZnkocGxhbikKICAgICAgICAmJiBKU09OLnN0cmluZ2lmeSh2YWx1ZS5wb2ludGVyKSA9PT0gSlNPTi5zdHJpbmdpZnkoYXdhaXQgcG9pbnRlcigpKSk7IHJldHVybiB7IG1vZGVzOiB2YWx1ZS5tb2RlcywgYmFja3VwU2hhMjU2OiBzYXZlZC5zaGEyNTYgfTsKICAgIH0sCiAgICBhc3luYyByZXBsYWNlKG5hbWUsIGV4cGVjdGVkLCBieXRlcywgbW9kZSkgewogICAgICByb290KCk7IG5lZWQoT2JqZWN0Lmhhc093bihmaWxlcywgbmFtZSkpOyBhd2FpdCBwb2ludGVyKCk7IGNvbnN0IGN1cnJlbnQgPSBhd2FpdCByZWFkKGZpbGVzW25hbWVdKTsKICAgICAgbmVlZChjdXJyZW50LnNoYTI1NiA9PT0gZXhwZWN0ZWQuc2hhMjU2ICYmIGN1cnJlbnQuc2lnbmF0dXJlID09PSBleHBlY3RlZC5zaWduYXR1cmUpOyBhd2FpdCBhdG9taWMoZmlsZXNbbmFtZV0sIGJ5dGVzLCBtb2RlLCBjdXJyZW50LCBjdXJyZW50LmdpZCk7CiAgICB9LAogICAgYXN5bmMgdGVzdCgpIHsgcm9vdCgpOyBhd2FpdCBjb21tYW5kKCcvdXNyL3NiaW4vbmdpbngnLCBbJy10JywgJy1jJywgZmlsZXMubWFpbl0sIHsgY3dkOiAnLycsIGVudjogeyBQQVRIOiAnL3Vzci9zYmluOi91c3IvYmluOi9zYmluOi9iaW4nLCBMQU5HOiAnQycgfSwgdGltZW91dDogMTAwMDAsIG1heEJ1ZmZlcjogNjU1MzYgfSk7IH0sCiAgICBhc3luYyByZWxvYWQoKSB7IHJvb3QoKTsgYXdhaXQgY29tbWFuZCgnL3Vzci9zYmluL25naW54JywgWyctcycsICdyZWxvYWQnLCAnLWMnLCBmaWxlcy5tYWluXSwgeyBjd2Q6ICcvJywgZW52OiB7IFBBVEg6ICcvdXNyL3NiaW46L3Vzci9iaW46L3NiaW46L2JpbicsIExBTkc6ICdDJyB9LCB0aW1lb3V0OiAxMDAwMCwgbWF4QnVmZmVyOiA2NTUzNiB9KTsgfSwKICB9Owp9Cg==';

export function driverAuditSupabaseCanarySource() {
  const bytes = Buffer.from(frozenSource, 'base64'); need(sha(bytes) === moduleSha256); return bytes;
}

function sealRoot(publicKey, value) {
  const recipient = createPublicKey(publicKey), bytes = Buffer.from(JSON.stringify(value));
  need(recipient.asymmetricKeyType === 'rsa' && recipient.asymmetricKeyDetails.modulusLength >= 3072 && bytes.length <= 64 * 1024);
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { version: 1, key: publicEncrypt({ key: recipient, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

export function createDriverAuditSupabasePromotionPlan({ canaryPlan }, { verifyCanaryPlan } = {}) {
  need(typeof verifyCanaryPlan === 'function');
  const verified = verifyCanaryPlan({ main: Buffer.from(canaryPlan.before.main, 'base64'), site: Buffer.from(canaryPlan.before.site, 'base64'),
    selector: canaryPlan.selector, entryNonce: canaryPlan.entryNonce, issuedAt: canaryPlan.issuedAt, ttlSeconds: canaryPlan.ttlSeconds });
  need(JSON.stringify(verified) === JSON.stringify(canaryPlan));
  const original = Object.fromEntries(['main', 'site'].map(name => [name, Buffer.from(canaryPlan.before[name], 'base64').toString()]));
  const sealed = Object.fromEntries(['main', 'site'].map(name => [name, Buffer.from(canaryPlan.sealed[name], 'base64').toString()]));
  const oldMap = /^# BEGIN MATTER REPORTS CANARY MAP\n[\s\S]*?# END MATTER REPORTS CANARY MAP\n/gm;
  need([...sealed.main.matchAll(oldMap)].length === 1);
  const scope = '(?:/driver-audit-view|/api/driver-audits/session|/api/session(?:/refresh)?|/api/reporting/.*|/report-data/.*|/report-assets/.*)';
  const main = sealed.main.replace(oldMap, '# BEGIN MATTER REPORTS SELECTED MAP\n'
    + 'map $uri $matter_driver_reports_selected {\n    default 0;\n    "~^' + scope + '$" 1;\n}\n# END MATTER REPORTS SELECTED MAP\n');
  const site = sealed.site.replaceAll('MATTER REPORTS CANARY', 'MATTER REPORTS SELECTED')
    .replaceAll('@matter_driver_reports_canary', '@matter_driver_reports_selected')
    .replaceAll('$matter_driver_reports_canary = 1', '$matter_driver_reports_selected = 1');
  need(!main.includes('$cookie_') && !main.includes('$msec') && !site.includes(canaryPlan.entryPath)
    && !site.includes(canaryPlan.selector) && !site.includes('Set-Cookie'));
  const promoted = { main, site };
  for (const name of ['main', 'site']) need(promoted[name].replace(/^[ \t]*# BEGIN MATTER REPORTS SELECTED [A-Z]+\n[\s\S]*?[ \t]*# END MATTER REPORTS SELECTED [A-Z]+\n/gm, '') === original[name]);
  const value = { version: 1, kind: 'supabase-report-routing-promotion-plan-v1', canaryPlanSha256: canaryPlan.planSha256,
    before: canaryPlan.sealed, promoted: Object.fromEntries(Object.entries(promoted).map(([name, text]) => [name, Buffer.from(text).toString('base64')])) };
  return { ...value, promotionSha256: sha(JSON.stringify(value)) };
}

// The caller pins this whole approval artifact. This validator binds its
// identified job/browser/byte-comparison evidence; it never invents acceptance.
export function validateDriverAuditSupabaseCanaryAcceptance({ bytes, sha256, canaryPlan, readiness, handshake, now, admittedAt }) {
  const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(name => Object.hasOwn(value, name));
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const clock = value => {
    need(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value));
    const time = Date.parse(value); need(Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)); return time;
  };
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 16 * 1024 && digest(sha256) && sha(bytes) === sha256
    && Buffer.from(bytes.toString()).equals(bytes) && Buffer.isBuffer(handshake) && handshake.length <= 32 * 1024 && Number.isSafeInteger(now));
  const a = JSON.parse(bytes), h = JSON.parse(handshake), admission = admittedAt === undefined ? now : admittedAt;
  need(Number.isSafeInteger(admission) && admission <= now && exact(a, ['version', 'kind', 'planSha256', 'preparedReceiptSha256',
    'applicationCommit', 'releaseCommit', 'checkedAt', 'current', 'previous', 'host', 'browser', 'packages', 'sourceHeads', 'sourceHeadsProofSha256'])
    && a.version === 1 && a.kind === 'supabase-browser-canary-acceptance-v1' && a.planSha256 === canaryPlan.planSha256
    && a.preparedReceiptSha256 === readiness.preparedReceiptSha256
    && a.applicationCommit === '701655794e1711b4d8c737e929360ecfe5d2f0ca' && a.releaseCommit === '4a00becfe4954b8139df6ac3c6058c2a592484d2'
    && clock(a.checkedAt) >= clock(canaryPlan.issuedAt) && clock(a.checkedAt) <= admission
    && admission < clock(canaryPlan.expiresAt) && admission - clock(a.checkedAt) <= 300000);
  for (const value of [a.current, a.previous]) need(exact(value, ['collectorRevision', 'generation', 'reportHash', 'manifestSha256', 'sourceBasis'])
    && positive(value.collectorRevision) && ['generation', 'reportHash', 'manifestSha256', 'sourceBasis'].every(name => digest(value[name])));
  need(a.current.collectorRevision === 5771 && readiness.reportHealth.collectorRevision === 5771
    && a.current.generation === readiness.reportHealth.generation && a.current.reportHash === readiness.reportHealth.reportHash
    && a.previous.collectorRevision === 5463 && a.previous.generation === '15d10c15a4e3ca405ba8a39b328f14023be977e91cc3ee003622d6c086da8709'
    && a.previous.manifestSha256 === '3ac4484fe65910ce356eee487e8ebe4a50b0f52e64d81e892fb2c4b1ea8325c2');
  need(exact(a.host, ['repository', 'runId', 'jobId', 'workflowCommit', 'operatorSha256', 'jobSha256', 'logSha256', 'handshakeSha256',
    'envelopeSha256', 'metadataSha256', 'operation', 'status', 'conclusion', 'completedAt'])
    && typeof a.host.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a.host.repository)
    && positive(a.host.runId) && positive(a.host.jobId) && typeof a.host.workflowCommit === 'string' && /^[a-f0-9]{40}$/.test(a.host.workflowCommit)
    && ['operatorSha256', 'jobSha256', 'logSha256', 'handshakeSha256', 'envelopeSha256', 'metadataSha256'].every(name => digest(a.host[name]))
    && a.host.operation === 'seal-entry' && a.host.status === 'completed' && a.host.conclusion === 'success'
    && clock(a.host.completedAt) >= clock(canaryPlan.issuedAt) && clock(a.host.completedAt) <= clock(a.checkedAt));
  need(h.version === 1 && h.kind === 'supabase-canary-host-handshake-v1' && h.applicationCommit === a.applicationCommit
    && h.preparedReceiptSha256 === a.preparedReceiptSha256 && a.host.handshakeSha256 === sha(handshake)
    && a.host.envelopeSha256 === sha(JSON.stringify(h.root)) && a.host.metadataSha256 === h.root?.metadataSha256
    && h.root.status === 'canary-root-seal-entry' && h.root.operation === 'seal-entry' && h.root.planSha256 === a.planSha256
    && h.root.privilegeVerified === true && h.root.readOnly === false && h.root.defaultRoutingChanged === false);
  need(exact(a.browser, ['kind', 'receiptSha256', 'checkedAt', 'generation', 'reportHash', 'checks'])
    && a.browser.kind === 'authenticated-own-staff-browser' && digest(a.browser.receiptSha256)
    && clock(a.browser.checkedAt) >= clock(canaryPlan.issuedAt) && clock(a.browser.checkedAt) <= clock(a.checkedAt)
    && a.browser.generation === a.current.generation && a.browser.reportHash === a.current.reportHash
    && exact(a.browser.checks, ['business', 'gps', 'photos', 'reviews']));
  for (const check of Object.values(a.browser.checks)) need(exact(check, ['status', 'evidenceSha256']) && check.status === 'passed' && digest(check.evidenceSha256));
  need(exact(a.packages, ['kind', 'receiptSha256', 'current', 'previous']) && a.packages.kind === 'supabase-original-package-byte-comparison-v1'
    && digest(a.packages.receiptSha256));
  for (const role of ['current', 'previous']) need(exact(a.packages[role], ['manifestSha256', 'businessSha256', 'gpsSha256', 'photosSha256', 'historySha256'])
    && Object.values(a.packages[role]).every(digest) && a.packages[role].manifestSha256 === a[role].manifestSha256);
  need(a.sourceHeads && typeof a.sourceHeads === 'object' && !Array.isArray(a.sourceHeads) && Object.keys(a.sourceHeads).length === 8
    && digest(a.sourceHeadsProofSha256) && a.sourceHeads['collector-state']?.revision === 5771
    && a.sourceHeads['collector-state'].bodySha256 === '836c9507dd7704b40c876bf050e55fe487cddfc124b6a38f4f4af87993f5ad62');
  const originalHeadNames = ['collector-state', 'review-journal', 'preview-gps-map-20261106:review-journal',
    'preview-acceptance-gps-final-20261111:review-journal', 'preview-acceptance-gps-hosted-20261109:review-journal',
    'preview-acceptance-hosted-20261109:review-journal', 'preview-acceptance-household-20261109:review-journal',
    'preview-acceptance-reconcile-20261109:review-journal'];
  need(JSON.stringify(Object.keys(a.sourceHeads).sort()) === JSON.stringify(originalHeadNames.sort()));
  for (const [name, head] of Object.entries(a.sourceHeads)) need(typeof name === 'string' && name.length <= 512
    && (name === 'collector-state' || /(^|:)review-journal$/.test(name)) && !/[\u0000-\u001f]/.test(name)
    && exact(head, ['revision', 'bodySha256']) && positive(head.revision) && digest(head.bodySha256));
  return a;
}

export async function executeDriverAuditSupabasePromotion({ canaryPlan, restore = false, allowPromoted = false }, executor, createPromotion) {
  need(typeof restore === 'boolean' && typeof allowPromoted === 'boolean' && typeof createPromotion === 'function');
  const promotion = createPromotion({ canaryPlan }), decode = value => Buffer.from(value, 'base64');
  return executor.withLock(async () => {
    const readKnown = async () => {
      const value = await executor.read();
      for (const name of ['main', 'site']) need(value[name].mode === 0o600 && [promotion.before, promotion.promoted]
        .some(variant => value[name].sha256 === sha(decode(variant[name]))));
      return value;
    };
    const verify = async variant => {
      const value = await readKnown(); for (const name of ['main', 'site']) need(value[name].sha256 === sha(decode(variant[name])));
    };
    const initial = await readKnown();
    if (!restore && !allowPromoted) for (const name of ['main', 'site']) need(initial[name].sha256 === sha(decode(promotion.before[name])));
    await executor.backup(canaryPlan, false);
    const write = async variant => {
      const before = await readKnown();
      for (const name of ['main', 'site']) {
        const bytes = decode(variant[name]); if (before[name].sha256 !== sha(bytes)) await executor.replace(name, before[name], bytes, 0o600);
      }
      await verify(variant);
    };
    const testReload = async variant => { await executor.test(); await verify(variant); await executor.reload(); await verify(variant); };
    try {
      const target = restore ? promotion.before : promotion.promoted;
      await write(target); await testReload(target);
      return { status: restore ? 'promotion-rolled-back' : 'report-routing-promoted', canaryPlanSha256: canaryPlan.planSha256,
        promotionSha256: promotion.promotionSha256, defaultReportTarget: restore ? 'canary' : 'supabase',
        businessRoutingChanged: false, entryRemoved: true, cookieSelectorRemoved: !restore, authGranted: false,
        reloadRequested: true, liveRoutingVerified: false };
    } catch {
      let rollbackRestored = false;
      try { await write(promotion.before); await testReload(promotion.before); rollbackRestored = true; } catch { /* Preserve an independent configuration edit. */ }
      throw Object.assign(Error('Report routing promotion stopped'), { rollbackRestored });
    }
  });
}

// This function is self-contained when appended to the hash-pinned module.
// The adapters are an in-process local-test boundary, never JSON input.
export async function runDriverAuditSupabaseCanaryRoot(input, api) {
  const require = value => { if (!value) throw Error('Canary root guard failed'); };
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const operation = input?.operation;
  const promoting = operation === 'promote', rollingBackPromotion = operation === 'rollback-promotion';
  const fields = ['operation', 'recipientPublicKey'];
  require(['probe', 'plan', 'enable', 'seal-entry', 'restore', 'promote', 'rollback-promotion'].includes(operation)
    && exact(input, operation === 'probe' ? fields : operation === 'plan' ? [...fields, 'readiness']
      : promoting ? [...fields, 'readiness', 'planSha256', 'canaryAcceptanceSha256', 'acceptanceBase64', 'sealHandshakeBase64']
        : rollingBackPromotion ? [...fields, 'planSha256', 'canaryAcceptanceSha256']
      : operation === 'enable' ? [...fields, 'readiness', 'planSha256'] : [...fields, 'planSha256'])
    && api.uid() === 0 && api.platform === 'linux' && api.nodeExecutable === '/usr/bin/node' && api.nodeVersion === 'v22.23.4'
    && api.moduleSha256 === 'fcb260ebc47901fb3ea817a4da8f67df91262ec125cad4ad7c03a0db2481fcb2');
  require(typeof input.recipientPublicKey === 'string' && input.recipientPublicKey.length <= 8192
    && !input.recipientPublicKey.includes('PRIVATE KEY')
    && /^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(input.recipientPublicKey));
  const key = createPublicKey(input.recipientPublicKey);
  require(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072);
  if (operation === 'plan' || operation === 'enable' || promoting) {
    const value = input.readiness, health = value?.reportHealth;
    require(exact(value, ['version', 'preparedReceiptSha256', 'codeSha256', 'workersSha256', 'listenerSha256',
      'businessHealthy', 'sourceAbsent', 'syncStopped', 'reportHealth']) && value.version === 1
      && ['preparedReceiptSha256', 'codeSha256', 'workersSha256', 'listenerSha256'].every(name => digest(value[name]))
      && value.businessHealthy === true && value.sourceAbsent === true && value.syncStopped === true
      && exact(health, ['service', 'dataStore', 'executionHost', 'ready', 'generation', 'reportHash', 'collectorRevision', 'release'])
      && health.service === 'driver-reports' && health.dataStore === 'supabase' && health.executionHost === 'sidi' && health.ready === true
      && digest(health.generation) && digest(health.reportHash) && [5463, 5771].includes(health.collectorRevision)
      && health.release === '4a00becfe4954b8139df6ac3c6058c2a592484d2');
  }
  if (!['probe', 'plan'].includes(operation)) require(digest(input.planSha256));
  const executor = api.createExecutor(), io = api.filesystem, folder = '/var/lib/matter-driver-reports-canary';
  const sig = value => [value.dev, value.ino, value.uid, value.gid, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
  const id = value => [value.dev, value.ino, value.uid, value.gid, value.mode].map(String).join(':');
  async function record(name, bytes) {
    require(/^(?:control|promotion-intent|promotion-complete)-[a-f0-9]{64}\.json$/.test(name));
    const before = await io.lstat(folder, { bigint: true });
    require(before.isDirectory() && before.uid === 0n && !(Number(before.mode) & 0o077) && await io.realpath(folder) === folder);
    const parent = await io.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const named = path.join(folder, name), anchored = '/proc/self/fd/' + parent.fd + '/' + name;
    const check = async () => require(id(await parent.stat({ bigint: true })) === id(before)
      && id(await io.lstat(folder, { bigint: true })) === id(before) && await io.realpath(folder) === folder);
    try {
      await check();
      const handle = await io.open(anchored, bytes ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
        : constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const initial = await handle.stat({ bigint: true });
        require(initial.isFile() && initial.uid === 0n && !(Number(initial.mode) & 0o077) && initial.size <= 128n * 1024n);
        if (bytes) { require(bytes.length <= 128 * 1024); await handle.writeFile(bytes); await handle.sync(); await parent.sync(); }
        const stat = await handle.stat({ bigint: true }), output = bytes ?? Buffer.alloc(Number(stat.size));
        if (!bytes) {
          for (let offset = 0; offset < output.length;) {
            const result = await handle.read(output, offset, output.length - offset, offset); require(result.bytesRead > 0); offset += result.bytesRead;
          }
          require((await handle.read(Buffer.alloc(1), 0, 1, output.length)).bytesRead === 0);
        }
        await check();
        require(sig(await handle.stat({ bigint: true })) === sig(stat) && sig(await io.lstat(named, { bigint: true })) === sig(stat)
          && await io.realpath(named) === named);
        return output;
      } finally { await handle.close(); }
    } finally { await parent.close(); }
  }
  const seal = metadata => {
    const raw = Buffer.from(JSON.stringify(metadata)), packed = gzipSync(raw);
    const reused = promoting && metadata.recovered === true;
    require(raw.length <= 384 * 1024 && packed.length <= 40 * 1024);
    return { status: 'canary-root-' + operation, operation, planSha256: metadata.planSha256 ?? null,
      metadataSha256: sha(raw), recipientSha256: sha(input.recipientPublicKey), privilegeVerified: true,
      readOnly: operation === 'probe', routingChanged: !['probe', 'plan'].includes(operation) && !reused,
      defaultRoutingChanged: (promoting || rollingBackPromotion) && !reused,
      ...((promoting || rollingBackPromotion) ? { canaryAcceptanceSha256: input.canaryAcceptanceSha256,
        defaultReportTarget: promoting ? 'supabase' : 'canary', businessRoutingChanged: false, reusedCompletion: reused } : {}),
      capsule: api.seal(input.recipientPublicKey, { version: 1, kind: 'supabase-canary-control-capsule-v1',
        metadataSha256: sha(raw), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') }) };
  };
  if (operation === 'probe') {
    const actual = await executor.read();
    return seal({ version: 1, kind: 'supabase-canary-privilege-probe-v1', rootUid: 0, nodeExecutable: api.nodeExecutable,
      nodeVersion: api.nodeVersion, canaryModuleSha256: api.moduleSha256,
      nginx: { main: actual.main.sha256, site: actual.site.sha256 }, readOnly: true });
  }
  if (operation === 'plan') return executor.withLock(async () => {
    const original = await executor.read();
    const plan = api.createPlan({ main: original.main.bytes, site: original.site.bytes,
      issuedAt: new Date(Math.floor(api.now() / 1000) * 1000).toISOString(), ttlSeconds: 600 });
    const backup = await executor.backup(plan, true), readinessSha256 = sha(JSON.stringify(input.readiness));
    const control = { version: 1, kind: 'supabase-canary-root-control-v1', plan, readiness: input.readiness, readinessSha256,
      recipientSha256: sha(input.recipientPublicKey), canaryModuleSha256: api.moduleSha256, backupSha256: backup.backupSha256 };
    const bytes = Buffer.from(JSON.stringify(control)), name = 'control-' + plan.planSha256 + '.json';
    await record(name, bytes); require((await record(name)).equals(bytes));
    return seal({ ...control, planSha256: plan.planSha256, controlSha256: sha(bytes), diff: api.diff(plan), routingChanged: false });
  });
  const bytes = await record('control-' + input.planSha256 + '.json'), saved = JSON.parse(bytes);
  require(exact(saved, ['version', 'kind', 'plan', 'readiness', 'readinessSha256', 'recipientSha256', 'canaryModuleSha256', 'backupSha256'])
    && saved.version === 1 && saved.kind === 'supabase-canary-root-control-v1' && saved.plan.planSha256 === input.planSha256
    && saved.recipientSha256 === sha(input.recipientPublicKey) && saved.canaryModuleSha256 === api.moduleSha256
    && saved.readinessSha256 === sha(JSON.stringify(saved.readiness)) && digest(saved.backupSha256));
  if (operation === 'enable' || promoting) require(saved.readinessSha256 === sha(JSON.stringify(input.readiness)));
  if (promoting || rollingBackPromotion) {
    require(digest(input.canaryAcceptanceSha256));
    const promotion = api.createPromotion({ canaryPlan: saved.plan });
    const intentName = 'promotion-intent-' + input.planSha256 + '.json', completeName = 'promotion-complete-' + input.planSha256 + '.json';
    const optional = async name => { try { return await record(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    let intentBytes = await optional(intentName), completeBytes = await optional(completeName);
    let intent = intentBytes && JSON.parse(intentBytes), completion = completeBytes && JSON.parse(completeBytes);
    const checkIntent = value => require(exact(value, ['version', 'kind', 'planSha256', 'canaryAcceptanceSha256', 'controlSha256', 'readinessSha256',
      'promotionSha256', 'admittedAt', 'sealMetadataSha256']) && value.version === 1 && value.kind === 'supabase-report-promotion-intent-v1'
      && value.planSha256 === input.planSha256 && value.canaryAcceptanceSha256 === input.canaryAcceptanceSha256
      && value.controlSha256 === sha(bytes) && value.readinessSha256 === saved.readinessSha256 && value.promotionSha256 === promotion.promotionSha256
      && typeof value.admittedAt === 'string' && new Date(value.admittedAt).toISOString() === value.admittedAt
      && Date.parse(value.admittedAt) >= Date.parse(saved.plan.issuedAt) && Date.parse(value.admittedAt) < Date.parse(saved.plan.expiresAt)
      && Date.parse(value.admittedAt) <= api.now() && digest(value.sealMetadataSha256));
    if (intent) checkIntent(intent);
    const expectedResult = { status: 'report-routing-promoted', canaryPlanSha256: input.planSha256, promotionSha256: promotion.promotionSha256,
      defaultReportTarget: 'supabase', businessRoutingChanged: false, entryRemoved: true, cookieSelectorRemoved: true,
      authGranted: false, reloadRequested: true, liveRoutingVerified: false };
    if (completion) require(intent && exact(completion, ['version', 'kind', 'intentSha256', 'admittedAt', 'confirmedAt', 'result'])
      && completion.version === 1 && completion.kind === 'supabase-report-promotion-completion-v1' && completion.intentSha256 === sha(intentBytes)
      && completion.admittedAt === intent.admittedAt && typeof completion.confirmedAt === 'string'
      && new Date(completion.confirmedAt).toISOString() === completion.confirmedAt && Date.parse(completion.confirmedAt) >= Date.parse(intent.admittedAt)
      && Date.parse(completion.confirmedAt) <= api.now() && JSON.stringify(completion.result) === JSON.stringify(expectedResult));
    if (rollingBackPromotion) {
      require(intent);
      const result = await api.executePromotion({ canaryPlan: saved.plan, restore: true, allowPromoted: true }, executor, api.createPromotion);
      return seal({ version: 1, kind: 'supabase-report-promotion-rollback-v1', planSha256: input.planSha256,
        canaryAcceptanceSha256: input.canaryAcceptanceSha256, originalAdmissionAt: intent.admittedAt, result });
    }
    const decode = (value, maximum) => { require(typeof value === 'string' && value.length > 0 && value.length <= maximum
      && Buffer.from(value, 'base64').toString('base64') === value); return Buffer.from(value, 'base64'); };
    const acceptanceBytes = decode(input.acceptanceBase64, 24 * 1024), handshake = decode(input.sealHandshakeBase64, 48 * 1024);
    const current = await executor.read(), alreadyPromoted = ['main', 'site'].every(name => current[name].mode === 0o600
      && current[name].sha256 === sha(Buffer.from(promotion.promoted[name], 'base64')));
    validateDriverAuditSupabaseCanaryAcceptance({ bytes: acceptanceBytes, sha256: input.canaryAcceptanceSha256,
      canaryPlan: saved.plan, readiness: input.readiness, handshake, now: api.now(),
      ...(completion && alreadyPromoted ? { admittedAt: Date.parse(intent.admittedAt) } : {}) });
    const h = JSON.parse(handshake), sealedResult = { status: 'seal-entry', planSha256: input.planSha256, expiresAt: saved.plan.expiresAt,
      entrySealed: true, authGranted: false, defaultRoutingChanged: false, reloadRequested: true, liveRoutingVerified: false };
    const sealedMetadata = { version: 1, kind: 'supabase-canary-execution-v1', planSha256: input.planSha256,
      controlSha256: sha(bytes), readinessSha256: saved.readinessSha256, result: sealedResult, canaryModuleSha256: api.moduleSha256 };
    require(h.root.metadataSha256 === sha(JSON.stringify(sealedMetadata)));
    if (completion && alreadyPromoted) return seal({ version: 1, kind: 'supabase-report-routing-promoted-v1', planSha256: input.planSha256,
      canaryAcceptanceSha256: input.canaryAcceptanceSha256, completion, completionSha256: sha(completeBytes), recovered: true });
    for (const name of ['main', 'site']) require(current[name].mode === 0o600 && current[name].sha256 === sha(Buffer.from(promotion.before[name], 'base64')));
    if (!intent) {
      intent = { version: 1, kind: 'supabase-report-promotion-intent-v1', planSha256: input.planSha256,
        canaryAcceptanceSha256: input.canaryAcceptanceSha256, controlSha256: sha(bytes), readinessSha256: saved.readinessSha256,
        promotionSha256: promotion.promotionSha256, admittedAt: new Date(api.now()).toISOString(), sealMetadataSha256: h.root.metadataSha256 };
      intentBytes = Buffer.from(JSON.stringify(intent)); await record(intentName, intentBytes); require((await record(intentName)).equals(intentBytes));
    }
    require(intent.sealMetadataSha256 === h.root.metadataSha256);
    let executed = false;
    try {
      const result = await api.executePromotion({ canaryPlan: saved.plan }, executor, api.createPromotion); executed = true;
      if (!completion) {
        completion = { version: 1, kind: 'supabase-report-promotion-completion-v1', intentSha256: sha(intentBytes),
          admittedAt: intent.admittedAt, confirmedAt: new Date(api.now()).toISOString(), result };
        completeBytes = Buffer.from(JSON.stringify(completion)); await record(completeName, completeBytes);
      }
      require((await record(completeName)).equals(completeBytes) && (await record('control-' + input.planSha256 + '.json')).equals(bytes));
      return seal({ version: 1, kind: 'supabase-report-routing-promoted-v1', planSha256: input.planSha256,
        canaryAcceptanceSha256: input.canaryAcceptanceSha256, completion, completionSha256: sha(completeBytes), recovered: false });
    } catch (error) {
      if (executed) try { await api.executePromotion({ canaryPlan: saved.plan, restore: true, allowPromoted: true }, executor, api.createPromotion); } catch { /* Preserve conflicting configuration. */ }
      throw error;
    }
  }
  const result = await api.execute({ operation, plan: saved.plan }, executor);
  require((await record('control-' + input.planSha256 + '.json')).equals(bytes));
  return seal({ version: 1, kind: 'supabase-canary-execution-v1', planSha256: input.planSha256,
    controlSha256: sha(bytes), readinessSha256: saved.readinessSha256, result, canaryModuleSha256: api.moduleSha256 });
}

export function driverAuditSupabaseCanaryRootInput(input) {
  const payload = Buffer.from(JSON.stringify(input)); need(payload.length <= 32 * 1024);
  const source = driverAuditSupabaseCanarySource();
  const driver = `\nimport { createPublicKey, createCipheriv, publicEncrypt } from 'node:crypto';\nimport { gzipSync } from 'node:zlib';\n`
    + sealRoot.toString() + '\n'
    + createDriverAuditSupabasePromotionPlan.toString() + '\n' + validateDriverAuditSupabaseCanaryAcceptance.toString() + '\n'
    + executeDriverAuditSupabasePromotion.toString() + '\n'
    + 'const finishCanary=()=>{};for(const event of ["SIGTERM","SIGINT","SIGHUP"])process.on(event,finishCanary);\n'
    + 'try { const result = await (' + runDriverAuditSupabaseCanaryRoot.toString() + ')(JSON.parse(Buffer.from('
    + JSON.stringify(payload.toString('base64')) + ", 'base64')), {filesystem:fs,uid:()=>process.getuid(),platform:process.platform,"
    + "nodeVersion:process.version,nodeExecutable:await fs.realpath('/proc/self/exe'),now:()=>Date.now(),moduleSha256:"
    + JSON.stringify(moduleSha256) + ',createExecutor:createDriverAuditSupabaseCanaryExecutor,createPlan:createDriverAuditSupabaseCanaryPlan,'
    + 'diff:driverAuditSupabaseCanaryDiff,execute:executeDriverAuditSupabaseCanary,seal:sealRoot,'
    + 'createPromotion:value=>createDriverAuditSupabasePromotionPlan(value,{verifyCanaryPlan:createDriverAuditSupabaseCanaryPlan}),'
    + 'executePromotion:executeDriverAuditSupabasePromotion});process.stdout.write(JSON.stringify(result)); }'
    + 'catch { process.stderr.write("Canary privileged command stopped\\n"); process.exitCode=1; }'
    + 'finally{for(const event of ["SIGTERM","SIGINT","SIGHUP"])process.off(event,finishCanary);}\n';
  const output = Buffer.concat([source, Buffer.from(driver)]); need(output.length <= 128 * 1024); return output;
}

const pins = Object.freeze({ base: '701655794e1711b4d8c737e929360ecfe5d2f0ca', release: '4a00becfe4954b8139df6ac3c6058c2a592484d2',
  source: '8577fd973097dc543953b5af4ea9a3704b1d2c54bd016dd910a13e8560397fcc',
  builder: '76790677571490ea75f63c8954ac0c798311b80458b45bf1ccbf54f00ae0701d',
  baseline: '16bee9ba4531ac532bdf90e0b2fdf6271c86ee4b15db91de12449258b902bbf3',
  candidate: '83580f6e97ec429e46fd668db533fae601a72ab357b1aaad48ce242f70303f19' });
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(name => Object.hasOwn(value, name));
const signature = value => [value.dev, value.ino, value.uid, value.gid, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
const identity = value => [value.dev, value.ino, value.uid, value.gid, value.mode].map(String).join(':');
const codeFiles = ['loadEnv.js', 'package.json', 'package-lock.json', 'scripts/driverAuditHttp.js', 'scripts/driverAuditSync.js',
  'services/driverAuditHttp.js', 'services/driverAuditSupabaseAppBackend.js', 'services/driverAuditSupabaseReplica.js',
  'services/driverAuditSupabaseSync.js', 'services/driverAuditSupabaseTransfer.js', 'services/driverAuditSupabaseArchive.js',
  'services/driverAuditReadCache.js', 'services/driverAuditCollectorReadCache.js', 'services/driverAuditSpacesArchive.js',
  'vendor/driver-audits/integration/cloud/rpc.mjs', 'vendor/driver-audits/integration/hosted/supabase-archive.mjs',
  'vendor/driver-audits/integration/hosted/worker-lock.mjs'];

async function read(file, privateMode = true, maximum = 1024 * 1024) {
  const stat = await fs.lstat(file, { bigint: true });
  need(stat.isFile() && (stat.uid === BigInt(process.getuid()) || !privateMode && stat.uid === 0n)
    && !(Number(stat.mode) & (privateMode ? 0o077 : 0o022)) && stat.size > 0n && stat.size <= BigInt(maximum) && await fs.realpath(file) === file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    need(signature(await handle.stat({ bigint: true })) === signature(stat)); const bytes = Buffer.alloc(Number(stat.size));
    for (let offset = 0; offset < bytes.length;) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); need(result.bytesRead > 0); offset += result.bytesRead; }
    need((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0 && signature(await handle.stat({ bigint: true })) === signature(stat)
      && signature(await fs.lstat(file, { bigint: true })) === signature(stat) && await fs.realpath(file) === file);
    return { file, bytes, sha256: sha(bytes), signature: signature(stat) };
  } finally { await handle.close(); }
}

async function directory(folder) {
  const info = await fs.lstat(folder, { bigint: true });
  need(info.isDirectory() && info.uid === BigInt(process.getuid()) && !(Number(info.mode) & 0o077) && await fs.realpath(folder) === folder); return info;
}

// Observed only in the unchanged legacy701 checkout. Report entry points use
// explicit tracked imports; this uppercase singular path is never imported.
// Preserve it byte-for-byte rather than altering an unrelated business file.
async function preservedLegacyEvent(appRoot) {
  const relative = 'server/routes/Event.js', file = path.join(appRoot, relative), opened = [];
  const fileSignature = value => signature(value) + ':' + String(value.nlink);
  const checkParents = async () => {
    for (const row of opened) need(signature(await row.fd.stat({ bigint: true })) === signature(row.stat)
      && signature(await fs.lstat(row.path, { bigint: true })) === signature(row.stat) && await fs.realpath(row.path) === row.path);
  };
  try {
    for (const folder of [appRoot, path.join(appRoot, 'server'), path.join(appRoot, 'server/routes')]) {
      const stat = await fs.lstat(folder, { bigint: true });
      need(stat.isDirectory() && stat.uid === BigInt(process.getuid()) && !(Number(stat.mode) & 0o002) && await fs.realpath(folder) === folder);
      const fd = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push({ path: folder, stat, fd }); need(signature(await fd.stat({ bigint: true })) === signature(stat));
    }
    await checkParents(); const stat = await fs.lstat(file, { bigint: true });
    need(stat.isFile() && stat.uid === BigInt(process.getuid()) && stat.nlink === 1n
      && [0o600, 0o644, 0o664].includes(Number(stat.mode) & 0o7777) && stat.size <= 512n * 1024n && await fs.realpath(file) === file);
    const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      need(fileSignature(await fd.stat({ bigint: true })) === fileSignature(stat)); const bytes = Buffer.alloc(Number(stat.size));
      for (let offset = 0; offset < bytes.length;) { const row = await fd.read(bytes, offset, bytes.length - offset, offset); need(row.bytesRead > 0); offset += row.bytesRead; }
      need((await fd.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0
        && fileSignature(await fd.stat({ bigint: true })) === fileSignature(stat) && fileSignature(await fs.lstat(file, { bigint: true })) === fileSignature(stat)
        && await fs.realpath(file) === file); await checkParents();
      return { path: relative, sha256: sha(bytes), bytes: bytes.length,
        signature: signature(stat) + ':' + sha(JSON.stringify(opened.map(row => [path.relative(appRoot, row.path), identity(row.stat)]))), nlink: String(stat.nlink) };
    } finally { await fd.close(); }
  } finally { for (const row of opened.reverse()) await row.fd.close(); }
}

async function inDirectory(folder, operation) {
  const initial = await directory(folder), parent = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const check = async () => need(identity(await parent.stat({ bigint: true })) === identity(initial)
    && identity(await fs.lstat(folder, { bigint: true })) === identity(initial) && await fs.realpath(folder) === folder);
  try { await check(); const result = await operation(process.platform === 'linux' ? '/proc/self/fd/' + parent.fd : folder, parent); await check(); return result; }
  finally { await parent.close(); }
}

async function handshake(folder, value) {
  const bytes = Buffer.from(JSON.stringify(value)), name = 'handshake-' + sha(bytes) + '.private.json';
  need(bytes.length <= 128 * 1024 && /^handshake-[a-f0-9]{64}\.private\.json$/.test(name));
  const child = path.join(folder, 'canary');
  await inDirectory(folder, async (anchor, parent) => {
    await fs.mkdir(path.join(anchor, 'canary'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); await parent.sync();
  });
  await inDirectory(child, async (anchor, parent) => {
    let handle;
    try { handle = await fs.open(path.join(anchor, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (handle) try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await parent.sync(); need((await read(path.join(child, name))).bytes.equals(bytes));
  });
  return sha(bytes);
}

async function optionalRead(file, maximum) {
  try { return await read(file, true, maximum); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The recipe pins transport identity only. It does not assert browser acceptance
// or refresh any admission clock; the privileged verifier still checks the pack.
async function acceptanceArtifact({ folder, rawSha256, objectSha256, server, releaseRoot, releaseSha,
  cacheDirectory, load, verify, signal }) {
  const proofFile = path.join(folder, 'acceptance-' + rawSha256 + '.private.json');
  const recipeFile = path.join(folder, 'acceptance-' + rawSha256 + '.transport.private.json');
  const recipeBytes = Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-canary-acceptance-transport-v1',
    canaryAcceptanceSha256: rawSha256, canaryAcceptanceObjectSha256: objectSha256, key: objectSha256 + '.gz' }));
  const strictRead = async (file, maximum) => {
    const saved = await optionalRead(file, maximum);
    if (saved) need((Number((await fs.lstat(file)).mode) & 0o777) === 0o600);
    return saved;
  };
  let proof = await strictRead(proofFile, 16 * 1024), recipe = await strictRead(recipeFile, 4096);
  if (proof) need(proof.sha256 === rawSha256);
  if (recipe) need(recipe.bytes.equals(recipeBytes));
  if (proof && recipe) return { proof, recipe };

  const environmentFile = await read(path.join(server, '.env.local'), true, 256 * 1024);
  const dotenv = await load('node_modules/dotenv/lib/main.js', releaseRoot);
  const env = dotenv.parse(environmentFile.bytes);
  need(env.DRIVER_AUDIT_EXECUTION_HOST === 'sidi' && env.DRIVER_AUDIT_DATA_STORE === 'supabase'
    && env.DRIVER_AUDIT_IMPORT_ENABLED === '0' && env.DRIVER_AUDIT_REPLICA_GC_ENABLED === '0'
    && env.DRIVER_AUDIT_RELEASE_SHA === releaseSha && env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY === cacheDirectory
    && typeof env.MATTER_SUPABASE_SECRET === 'string' && env.MATTER_SUPABASE_SECRET.length > 0
    && env.MATTER_SUPABASE_SECRET === env.DRIVER_AUDIT_SUPABASE_SECRET
    && !Object.keys(env).some(name => /MONGO|NATIVE_CAPACITY|OIDC|NODE_OPTIONS|NODE_PATH|LD_PRELOAD/.test(name)));
  await directory(cacheDirectory);
  const module = await load('services/driverAuditSupabaseAppBackend.js', releaseRoot);
  let backend, raw;
  try {
    backend = await module.createDriverAuditSupabaseAppBackend({ env });
    need(backend.kind === 'supabase' && backend.executionHost === 'sidi' && backend.executionAdmission === 'fixed-host-v1'
      && backend.transferAccounting === 'supabase-http-bytes-v1' && backend.archiveCacheDirectory === cacheDirectory
      && backend.archive?.managedReadCache === true && typeof backend.archive.assertPrivate === 'function');
    signal.throwIfAborted();
    const privacy = await backend.archive.assertPrivate();
    need(privacy?.bucket === 'matter-report-archive' && privacy.public === false);
    const chunks = []; let size = 0;
    for await (const bytes of await backend.archive.readObject(objectSha256 + '.gz', { maxBytes: 64 * 1024,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) })) {
      signal.throwIfAborted(); need(bytes instanceof Uint8Array && (size += bytes.length) <= 64 * 1024); chunks.push(Buffer.from(bytes));
    }
    const compressed = Buffer.concat(chunks, size); need(compressed.length > 0 && sha(compressed) === objectSha256);
    raw = gunzipSync(compressed, { maxOutputLength: 16 * 1024 });
    need(raw.length > 0 && sha(raw) === rawSha256 && Buffer.from(raw.toString('utf8')).equals(raw));
    if (proof) need(proof.bytes.equals(raw));
  } finally { await backend?.close?.(); }
  signal.throwIfAborted();
  const currentEnvironment = await read(environmentFile.file, true, 256 * 1024);
  need(currentEnvironment.signature === environmentFile.signature && currentEnvironment.sha256 === environmentFile.sha256);
  await verify(); signal.throwIfAborted();
  const publish = async (file, bytes) => {
    await inDirectory(folder, async (anchor, parent) => {
      const names = await fs.readdir(anchor); need(names.length <= 4096);
      const stale = names.filter(name => /^\.acceptance-[a-f0-9]{32}\.tmp$/.test(name)); need(stale.length <= 8);
      for (const name of stale) {
        const temporary = path.join(anchor, name), before = await fs.lstat(temporary, { bigint: true });
        need(before.isFile() && before.uid === BigInt(process.getuid()) && (Number(before.mode) & 0o777) === 0o600
          && before.size <= 16n * 1024n && before.nlink >= 1n && before.nlink <= 2n);
        need(signature(await fs.lstat(temporary, { bigint: true })) === signature(before)); await fs.unlink(temporary);
      }
      if (stale.length) await parent.sync();
      const name = path.basename(file), temporary = '.acceptance-' + randomBytes(16).toString('hex') + '.tmp';
      let handle, created = false;
      try {
        handle = await fs.open(path.join(anchor, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true; await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
        try { await fs.link(path.join(anchor, temporary), path.join(anchor, name)); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await parent.sync();
        const saved = await strictRead(file, bytes.length); need(saved && saved.bytes.equals(bytes));
      } finally {
        await handle?.close();
        if (created) { await fs.unlink(path.join(anchor, temporary)); await parent.sync(); }
      }
    });
    return strictRead(file, bytes.length);
  };
  // A crash can leave a pinned recipe without a proof; that exact object may be
  // downloaded again. No partly written proof or different recipe is admitted.
  recipe = await publish(recipeFile, recipeBytes);
  proof = await publish(proofFile, raw);
  return { proof, recipe, environmentFile };
}

// No shell or caller-selected executable, arguments, cwd or environment.
async function rootCommand(input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sudo', ['-n', '--', '/usr/bin/node', '--input-type=module', '-'],
      { cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const parts = []; let size = 0, failed = false;
    const fail = () => { failed = true; child.kill('SIGTERM'); };
    const timer = setTimeout(fail, 60000);
    child.stdout.on('data', bytes => { if ((size += bytes.length) > 128 * 1024) fail(); else parts.push(bytes); });
    child.stderr.resume(); child.stdin.on('error', fail); child.once('error', fail);
    child.once('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(Error('Privileged canary command stopped')); else resolve(Buffer.concat(parts).toString()); });
    child.stdin.end(input);
  });
}

function rootResult(raw, operation, planSha256, recipientPublicKey, canaryAcceptanceSha256) {
  need(typeof raw === 'string' && Buffer.byteLength(raw) <= 128 * 1024); const value = JSON.parse(raw);
  const promotion = ['promote', 'rollback-promotion'].includes(operation);
  const reused = promotion && value.reusedCompletion === true;
  need(exact(value, ['status', 'operation', 'planSha256', 'metadataSha256', 'recipientSha256', 'privilegeVerified', 'readOnly',
    'routingChanged', 'defaultRoutingChanged', 'capsule', ...(promotion ? ['canaryAcceptanceSha256', 'defaultReportTarget', 'businessRoutingChanged', 'reusedCompletion'] : [])])
    && value.status === 'canary-root-' + operation && value.operation === operation
    && value.privilegeVerified === true && value.readOnly === (operation === 'probe') && value.defaultRoutingChanged === (promotion && !reused)
    && value.routingChanged === (!['probe', 'plan'].includes(operation) && !reused) && digest(value.metadataSha256)
    && value.recipientSha256 === sha(recipientPublicKey)
    && (operation === 'probe' ? value.planSha256 === null : operation === 'plan' ? digest(value.planSha256) : value.planSha256 === planSha256)
    && exact(value.capsule, ['version', 'key', 'iv', 'tag', 'data']) && value.capsule.version === 1);
  if (promotion) need(digest(canaryAcceptanceSha256) && value.canaryAcceptanceSha256 === canaryAcceptanceSha256
    && typeof value.reusedCompletion === 'boolean' && (operation === 'promote' || value.reusedCompletion === false)
    && value.businessRoutingChanged === false && value.defaultReportTarget === (operation === 'promote' ? 'supabase' : 'canary'));
  for (const [name, maximum, length] of [['key', 2048], ['iv', 16, 12], ['tag', 24, 16], ['data', 90 * 1024]]) {
    const text = value.capsule[name]; need(typeof text === 'string' && text.length > 0 && text.length <= maximum
      && Buffer.from(text, 'base64').toString('base64') === text && (length === undefined || Buffer.from(text, 'base64').length === length));
  }
  need(Buffer.from(value.capsule.key, 'base64').length >= 384); return value;
}

async function listenerFor(pid) {
  const rows = [];
  for (const name of ['tcp', 'tcp6']) {
    const bytes = await fs.readFile('/proc/net/' + name); need(bytes.length <= 1024 * 1024);
    for (const line of bytes.toString().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && fields[1]?.endsWith(':138A')) rows.push({ address: fields[1], inode: fields[9], uid: Number(fields[7]), family: name });
    }
  }
  need(rows.length === 1 && rows[0].address === '0100007F:138A' && rows[0].uid === process.getuid());
  const names = await fs.readdir('/proc/' + pid + '/fd'); need(names.length <= 4096); let matched = false;
  for (const name of names) if (await fs.readlink('/proc/' + pid + '/fd/' + name).catch(() => null) === 'socket:[' + rows[0].inode + ']') matched = true;
  need(matched); return rows[0];
}

export async function runDriverAuditSupabaseCanaryControl(args, adapters = {}) {
  let phase = 'inputs', attempted = false, completed, rollbackRestored = false, outward, recoveryAttempted = false;
  const locks = [], p = adapters.pins ?? pins, exec = adapters.exec ?? promisify(execFile);
  const command = adapters.rootCommand ?? rootCommand;
  const shell = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG'].includes(name)));
  let checkout, verify, operatorFolder, checkedPrivilege, promotionInputs, checkoutAttempt, checkoutDiagnostic, preservedBaseFiles;
  const controller = new AbortController(), interrupt = () => controller.abort(Error('Canary operation cancelled'));
  for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(event, interrupt);
  adapters.signal?.addEventListener('abort', interrupt);
  if (adapters.signal?.aborted) interrupt();
  const recover = async () => {
    if (!attempted || recoveryAttempted) return;
    recoveryAttempted = true;
    try {
      await checkedPrivilege();
      const operation = args.operation === 'promote' ? 'rollback-promotion' : 'restore';
      rootResult(await command(driverAuditSupabaseCanaryRootInput({ operation, recipientPublicKey: args.recipientPublicKey,
        planSha256: args.planSha256, ...(args.operation === 'promote' ? { canaryAcceptanceSha256: args.canaryAcceptanceSha256 } : {}) })),
      operation, args.planSha256, args.recipientPublicKey, args.canaryAcceptanceSha256); rollbackRestored = true;
    } catch { /* Keep the root backup and refuse to overwrite independent changes. */ }
  };
  const cancelled = async () => {
    if (controller.signal.aborted && !outward) {
      await recover(); outward = Object.assign(Error('Supabase canary control stopped at cancelled'), { phase: 'cancelled', rollbackRestored });
    }
  };
  try {
    controller.signal.throwIfAborted();
    const fields = ['operation', 'appRoot', 'expectedSha', 'recipientPublicKey'], operation = args?.operation;
    need(['probe', 'plan', 'enable', 'seal-entry', 'restore', 'promote'].includes(operation)
      && exact(args, operation === 'probe' ? fields : operation === 'plan' ? [...fields, 'preparedReceiptSha256']
        : operation === 'promote' ? [...fields, 'preparedReceiptSha256', 'planSha256', 'canaryAcceptanceSha256', 'canaryAcceptanceObjectSha256']
        : [...fields, 'preparedReceiptSha256', 'planSha256'])
      && (adapters.platform ?? process.platform) === 'linux' && (adapters.uid ?? (() => process.getuid()))() === 1000
      && args.expectedSha === p.base && path.isAbsolute(args.appRoot) && await fs.realpath(args.appRoot) === args.appRoot
      && (operation === 'probe' || digest(args.preparedReceiptSha256))
      && (['probe', 'plan'].includes(operation) || digest(args.planSha256))
      && (operation !== 'promote' || digest(args.canaryAcceptanceSha256) && digest(args.canaryAcceptanceObjectSha256)));
    need(typeof args.recipientPublicKey === 'string' && args.recipientPublicKey.length <= 8192 && !args.recipientPublicKey.includes('PRIVATE KEY'));
    const key = createPublicKey(args.recipientPublicKey); need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072);
    driverAuditSupabaseCanarySource();
    const call = (file, argv) => exec(file, argv, { cwd: args.appRoot, env: shell, timeout: 10000, maxBuffer: 8 * 1024 ** 2 });
    checkoutDiagnostic = async () => {
      const { folder, expected, names, step } = checkoutAttempt;
      const commands = [];
      for (const [name, arguments_] of [['head', ['rev-parse', 'HEAD']], ['toplevel', ['rev-parse', '--show-toplevel']],
        ['tracked-code', ['ls-files', '--error-unmatch', ...names.map(value => 'server/' + value)]],
        ['server-status', ['status', '--porcelain', '--untracked-files=all', '--', 'server']],
        ['server-diffstat', ['diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD', '--', 'server']]]) {
        let result, error;
        try { result = await exec('git', ['-C', folder, '--no-optional-locks', '-c', 'core.fsmonitor=false',
          '-c', 'core.hooksPath=/dev/null', ...arguments_], { cwd: args.appRoot, env: shell, timeout: 3000, maxBuffer: 16 * 1024 }); }
        catch (failure) { error = failure; result = failure; }
        const bounded = value => {
          const raw = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : Buffer.alloc(0);
          let text = raw.subarray(0, 2048).toString('utf8'), shortened = false;
          while (Buffer.byteLength(text) > 2048) { text = text.slice(0, -1); shortened = true; }
          return { text, bytes: raw.length, truncated: raw.length > 2048 || shortened };
        };
        const stdout = bounded(result?.stdout), stderr = bounded(result?.stderr);
        commands.push({ step: name, exitCode: !error ? 0 : Number.isSafeInteger(error.code) && error.code >= 0 && error.code <= 255 ? error.code : null,
          signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'].includes(error?.signal) ? error.signal : null,
          stdout: stdout.text, stderr: stderr.text, stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes,
          stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated });
      }
      const metadata = Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-canary-checkout-first-failure-v1',
        operation: args.operation, applicationCommit: args.expectedSha, operatorPhase: 'checkout',
        repositoryRole: folder === args.appRoot ? 'base' : 'release', repositoryRoot: folder, expectedCommit: expected, failedStep: step,
        commands, readOnly: true, guardChanged: false, acceptedAsVerified: false, sourceStarted: false, syncStarted: false, routingChanged: false }));
      need(metadata.length <= 24 * 1024); const packed = gzipSync(metadata);
      return { status: 'supabase-control-stopped', applicationCommit: args.expectedSha, operatorPhase: 'checkout', metadataSha256: sha(metadata),
        capsule: sealRoot(args.recipientPublicKey, { version: 1, kind: 'supabase-canary-checkout-failure-capsule-v1',
          applicationCommit: args.expectedSha, metadataSha256: sha(metadata), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') }) };
    };
    const checkRepo = async (folder, expected, names) => {
      checkoutAttempt = { folder, expected, names, step: 'head' };
      need((await call('git', ['-C', folder, 'rev-parse', 'HEAD'])).stdout.trim() === expected);
      checkoutAttempt.step = 'toplevel'; need((await call('git', ['-C', folder, 'rev-parse', '--show-toplevel'])).stdout.trim() === folder);
      checkoutAttempt.step = 'tracked-code';
      await call('git', ['-C', folder, 'ls-files', '--error-unmatch', ...names.map(name => 'server/' + name)]);
      checkoutAttempt.step = 'server-status';
      const statusArgs = ['-C', folder, 'status', '--porcelain', '--untracked-files=all', '--', 'server'];
      const status = (await call('git', statusArgs)).stdout;
      if (folder === args.appRoot && expected === p.base) {
        need(status === '' || status === '?? server/routes/Event.js\n');
        const current = status ? [await preservedLegacyEvent(folder)] : [];
        if (preservedBaseFiles === undefined) preservedBaseFiles = current;
        else need(JSON.stringify(current) === JSON.stringify(preservedBaseFiles));
        need((await call('git', statusArgs)).stdout === status);
      } else need(status === '');
    };
    checkout = () => checkRepo(args.appRoot, p.base, ['package.json', 'package-lock.json', 'vendor/driver-audits/integration/hosted/worker-lock.mjs']);
    phase = 'checkout'; await checkout();
    phase = 'privilege-probe';
    const executable = adapters.executable ?? (async file => {
      const stat = await fs.lstat(file, { bigint: true }); need(stat.isFile() && await fs.realpath(file) === file);
      return { path: file, uid: Number(stat.uid), mode: Number(stat.mode), signature: signature(stat) };
    });
    const executables = [];
    for (const file of ['/usr/bin/sudo', '/usr/bin/node']) {
      const value = await executable(file); need(value.path === file && value.uid === 0 && !(value.mode & 0o022)
        && (value.mode & 0o111) && typeof value.signature === 'string' && value.signature.length <= 512); executables.push(value);
    }
    checkedPrivilege = async () => { for (const value of executables) need(JSON.stringify(await executable(value.path)) === JSON.stringify(value)); };
    const invoke = async input => {
      controller.signal.throwIfAborted();
      await checkedPrivilege();
      if (['enable', 'seal-entry', 'promote'].includes(input.operation)) attempted = true;
      const result = rootResult(await command(driverAuditSupabaseCanaryRootInput(input)), input.operation, input.planSha256, args.recipientPublicKey, input.canaryAcceptanceSha256);
      await checkedPrivilege(); controller.signal.throwIfAborted(); return result;
    };
    const probe = await invoke({ operation: 'probe', recipientPublicKey: args.recipientPublicKey });
    await checkout(); if (operation === 'probe') return { ...probe, applicationCommit: p.base, directDatabaseConnections: 0, networkRequests: 0 };
    operatorFolder = path.join(args.appRoot, 'server/.private/driver-report-supabase-handoff'); await directory(operatorFolder);
    const load = (name, root = args.appRoot) => adapters.load ? adapters.load(name, root) : import(pathToFileURL(path.join(root, 'server', name)).href);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    const lock = async file => { await directory(path.dirname(file)); locks.push(await acquireWorkerLock(file)); };
    phase = 'operator-lock'; await lock(path.join(operatorFolder, 'operator.lock'));
    let readiness = null;
    if (operation === 'plan' || operation === 'enable' || operation === 'promote') {
      phase = 'prepared-host';
      const releaseRoot = path.join(args.appRoot, 'server/.private/driver-report-app-releases', p.release), server = path.join(releaseRoot, 'server');
      const rootId = sha(JSON.stringify(['driver-reports-supabase-sync-v1', p.release, p.source, p.builder, p.baseline, p.candidate]));
      const syncRoot = path.join(server, '.private/driver-audits', rootId), sourceRoot = path.join(server, '.private/driver-audit-source');
      const staged = await read(path.join(syncRoot, 'staging.private.json')); need(staged.sha256 === args.preparedReceiptSha256);
      const receipt = JSON.parse(staged.bytes);
      need(receipt.version === 1 && receipt.kind === 'supabase-sidi-host-staging-receipt-v1' && receipt.releaseSha === p.release
        && receipt.releaseRoot === releaseRoot && receipt.syncRoot === syncRoot && receipt.rootId === rootId
        && receipt.syncConfig === path.join(syncRoot, 'sync.json') && receipt.sourceConfig === path.join(sourceRoot, p.source, 'source.json')
        && receipt.sourceManifestSha256 === p.source && receipt.builderSha256 === p.builder
        && receipt.nodeExecutable === '/usr/bin/node' && receipt.nodeVersion === 'v22.23.4');
      const paths = [staged.file, receipt.syncConfig, receipt.sourceConfig,
        path.join(sourceRoot, p.source, 'runtime/manifest.private.json'), path.join(syncRoot, 'builder/runtime-manifest.json'),
        path.join(syncRoot, 'work/current.private.json')];
      const fixed = await Promise.all(paths.map(file => read(file)));
      need(fixed[3].sha256 === p.source && fixed[4].sha256 === p.builder);
      const pointer = JSON.parse(fixed[5].bytes); need(pointer.version === 1 && [5463, 5771].includes(pointer.collectorRevision)
        && digest(pointer.generation) && digest(pointer.reportHash));
      const repositories = async () => { await checkout(); await checkRepo(releaseRoot, p.release, codeFiles); };
      await repositories();
      phase = 'worker-locks';
      for (const root of [path.join(args.appRoot, 'server'), server]) {
        for (const name of ['source-deployment.lock', 'source-worker.lock']) await lock(path.join(root, '.private/driver-audit-source', name));
        await lock(path.join(root, '.private/driver-audits/sync-worker.lock'));
        const heavy = path.join(root, '.private/driver-audit-heavy-work');
        if (await fs.lstat(heavy).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) await lock(path.join(heavy, 'work.lock'));
      }
      const readNpm = adapters.systemFile ? () => adapters.systemFile('/usr/bin/npm') : async () => {
        const realpath = await fs.realpath('/usr/bin/npm'), saved = await read(realpath, false, 65536), stat = await fs.lstat(realpath);
        return { realpath, sha256: saved.sha256, uid: stat.uid, mode: stat.mode };
      };
      const npm = await readNpm();
      need(npm.uid === 0 && !(npm.mode & 0o022) && digest(npm.sha256)
        && /^\/usr\/(?:share\/nodejs|(?:local\/)?lib\/node_modules)\/npm\/bin\/npm-cli\.js$/.test(npm.realpath));
      const workers = async () => {
        const all = JSON.parse((await call('pm2', ['jlist'])).stdout); need(Array.isArray(all) && all.length <= 512);
        const one = name => { const values = all.filter(row => row.name === name); need(values.length === 1); return values[0]; };
        need(!all.some(row => row.name === 'matter-driver-audit-source'));
        const main = one('matter-delivery-api'), sync = one('matter-driver-audit-sync'), report = one('matter-driver-reports-api');
        need(main.pm2_env.status === 'online' && main.pid > 0 && main.pm2_env.pm_cwd === args.appRoot
          && ['/usr/bin/npm', npm.realpath].includes(main.pm2_env.pm_exec_path)
          && JSON.stringify(main.pm2_env.args) === '["start","--prefix","server"]');
        const syncServer = sync.pm2_env.pm_cwd, syncFile = sync.pm2_env.args?.[1];
        need([path.join(args.appRoot, 'server'), server].includes(syncServer) && sync.pm2_env.status === 'stopped' && sync.pid === 0
          && sync.pm2_env.pm_exec_path === path.join(syncServer, 'scripts/driverAuditSync.js') && Array.isArray(sync.pm2_env.args)
          && sync.pm2_env.args.length === 2 && sync.pm2_env.args[0] === '--config' && typeof syncFile === 'string'
          && path.dirname(path.dirname(syncFile)) === path.join(syncServer, '.private/driver-audits')
          && digest(path.basename(path.dirname(syncFile))) && path.basename(syncFile) === 'sync.json');
        need(report.pid > 0 && report.pm2_env.status === 'online' && report.pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditHttp.js')
          && report.pm2_env.pm_cwd === server && report.pm2_env.exec_interpreter === '/usr/bin/node'
          && JSON.stringify(report.pm2_env.args ?? []) === '[]' && JSON.stringify(report.pm2_env.node_args ?? []) === '[]');
        for (const row of [main, sync, report]) need(Number.isSafeInteger(row.pm_id) && row.pm_id >= 0 && Number.isSafeInteger(row.pid));
        const projection = row => ({ name: row.name, id: row.pm_id, pid: row.pid, status: row.pm2_env.status,
          script: row.pm2_env.pm_exec_path, cwd: row.pm2_env.pm_cwd, args: row.pm2_env.args ?? [],
          interpreter: row.pm2_env.exec_interpreter ?? null, startedAt: row.pm2_env.pm_uptime ?? null });
        return { rows: [main, sync, report].map(projection), report };
      };
      const json = async url => {
        const response = await (adapters.fetch ?? fetch)(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
        need(response.status === 200 && !response.redirected); const pieces = []; let size = 0;
        try { for await (const bytes of response.body) { need((size += bytes.length) <= 16384); pieces.push(Buffer.from(bytes)); } }
        finally { Promise.resolve(response.body?.cancel?.()).catch(() => {}); }
        return JSON.parse(Buffer.concat(pieces));
      };
      const snapshot = async () => {
        await repositories();
        need(JSON.stringify(await readNpm()) === JSON.stringify(npm));
        for (const saved of fixed) { const current = await read(saved.file); need(current.signature === saved.signature && current.sha256 === saved.sha256); }
        for (const name of ['deployment-source.private.json', 'source-state.private.json'])
          need(!await fs.lstat(path.join(path.dirname(receipt.sourceConfig), name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }));
        const state = await workers();
        if (adapters.inspectProcess) await adapters.inspectProcess(state.report, server);
        else need(await fs.realpath('/proc/' + state.report.pid + '/exe') === '/usr/bin/node' && await fs.realpath('/proc/' + state.report.pid + '/cwd') === server);
        const listener = await (adapters.listenerFor ?? listenerFor)(state.report.pid);
        const business = await json('http://127.0.0.1:5000/api/health'); need(business.database === 'connected');
        const health = await json('http://127.0.0.1:5002/health');
        need(exact(health, ['service', 'dataStore', 'executionHost', 'ready', 'generation', 'reportHash', 'collectorRevision', 'release'])
          && health.service === 'driver-reports' && health.dataStore === 'supabase' && health.executionHost === 'sidi' && health.ready === true
          && health.release === p.release && health.generation === pointer.generation && health.reportHash === pointer.reportHash
          && health.collectorRevision === pointer.collectorRevision);
        return { version: 1, preparedReceiptSha256: staged.sha256,
          codeSha256: sha(JSON.stringify([p.base, p.release, p.source, p.builder, npm.sha256, fixed.map(value => [value.file, value.sha256])])),
          workersSha256: sha(JSON.stringify(state.rows)), listenerSha256: sha(JSON.stringify(listener)),
          businessHealthy: true, sourceAbsent: true, syncStopped: true, reportHealth: health };
      };
      phase = 'readiness'; readiness = await snapshot();
      verify = async () => need(JSON.stringify(await snapshot()) === JSON.stringify(readiness));
      if (operation === 'promote') {
        phase = 'promotion-acceptance';
        const artifact = await acceptanceArtifact({ folder: path.join(operatorFolder, 'canary'), rawSha256: args.canaryAcceptanceSha256,
          objectSha256: args.canaryAcceptanceObjectSha256, server, releaseRoot, releaseSha: p.release,
          cacheDirectory: path.join(syncRoot, 'work/archive-cache'), load, verify, signal: controller.signal });
        const accepted = artifact.proof;
        const a = JSON.parse(accepted.bytes);
        need(a && typeof a === 'object' && !Array.isArray(a) && a.kind === 'supabase-browser-canary-acceptance-v1'
          && a.planSha256 === args.planSha256 && a.preparedReceiptSha256 === args.preparedReceiptSha256 && digest(a.host?.metadataSha256)
          && digest(a.host.handshakeSha256)
          && digest(a.current?.manifestSha256) && digest(a.current?.sourceBasis)
          && a.current.manifestSha256 === pointer.manifestSha256 && a.current.sourceBasis === pointer.sourceBasis);
        let sealedHandshake;
        try { sealedHandshake = await read(path.join(operatorFolder, 'canary', 'handshake-' + a.host.handshakeSha256 + '.private.json'), true, 32 * 1024); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // Prior reviewed cabd wrapper used one metadata-addressed slot.
          sealedHandshake = await read(path.join(operatorFolder, 'canary', 'seal-entry-' + a.host.metadataSha256 + '.private.json'), true, 32 * 1024);
        }
        const h = JSON.parse(sealedHandshake.bytes);
        rootResult(JSON.stringify(h.root), 'seal-entry', args.planSha256, args.recipientPublicKey);
        need(h.version === 1 && h.kind === 'supabase-canary-host-handshake-v1' && h.applicationCommit === p.base
          && h.preparedReceiptSha256 === args.preparedReceiptSha256 && a.host.handshakeSha256 === sealedHandshake.sha256);
        promotionInputs = { canaryAcceptanceSha256: args.canaryAcceptanceSha256, acceptanceBase64: accepted.bytes.toString('base64'),
          sealHandshakeBase64: sealedHandshake.bytes.toString('base64') };
        const recheck = verify;
        verify = async () => { await recheck(); for (const file of [accepted, artifact.recipe, sealedHandshake, artifact.environmentFile].filter(Boolean)) {
          const current = await read(file.file); need(current.signature === file.signature && current.sha256 === file.sha256);
        } };
      }
    } else verify = checkout;
    phase = 'root-' + operation;
    const input = { operation, recipientPublicKey: args.recipientPublicKey,
      ...(readiness ? { readiness } : {}), ...(!['probe', 'plan'].includes(operation) ? { planSha256: args.planSha256 } : {}), ...promotionInputs };
    completed = await invoke(input);
    phase = 'readback'; await verify();
    phase = 'handshake';
    const handshakeSha256 = await handshake(operatorFolder, { version: 1, kind: 'supabase-canary-host-handshake-v1',
      applicationCommit: p.base, preparedReceiptSha256: args.preparedReceiptSha256, probeMetadataSha256: probe.metadataSha256,
      readiness, root: completed, ...(operation === 'promote' ? { canaryAcceptanceObjectSha256: args.canaryAcceptanceObjectSha256 } : {}) });
    await verify(); controller.signal.throwIfAborted();
    return { ...completed, applicationCommit: p.base, handshakeSha256, directDatabaseConnections: 0,
      ...(operation === 'promote' ? { canaryAcceptanceObjectSha256: args.canaryAcceptanceObjectSha256 } : {}),
      sourceStarted: false, syncStarted: false, staffAuthorizationGranted: false, liveBrowserVerified: false };
  } catch {
    await recover(); if (controller.signal.aborted) phase = 'cancelled';
    outward = Object.assign(Error('Supabase canary control stopped at ' + phase), { phase, rollbackRestored });
    if (phase === 'checkout' && checkoutAttempt && checkoutDiagnostic) try {
      Object.defineProperty(outward, 'supabaseControlStopped', { value: await checkoutDiagnostic() });
    } catch { /* Diagnostics cannot replace or open the original closed guard. */ }
    throw outward;
  } finally {
    await cancelled();
    let failed = false;
    for (const lock of locks.reverse()) {
      try { await lock.release(); } catch { failed = true; }
      await cancelled();
    }
    if (failed && !outward) { await recover(); outward = Object.assign(Error('Supabase canary control stopped at cleanup'), { phase: 'cleanup', rollbackRestored }); }
    await cancelled();
    adapters.signal?.removeEventListener('abort', interrupt);
    for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(event, interrupt);
    if (outward) throw outward;
  }
}
