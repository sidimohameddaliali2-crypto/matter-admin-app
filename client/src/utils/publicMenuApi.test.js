import api from './publicMenuApi';
jest.mock('axios', () => jest.requireActual('axios/dist/node/axios.cjs'));

test('customer requests work when Safari/browser privacy settings block storage', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(window,'localStorage');
  Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Storage blocked','SecurityError');}});
  const original=api.defaults.adapter;
  api.defaults.adapter=async config=>({config,status:200,statusText:'OK',headers:{},data:{success:true}});
  try {
    const response=await api.get('/menus/share/fixture');
    expect(response.data.success).toBe(true);
    expect(response.config.headers.Authorization).toBeUndefined();
    expect(api.interceptors.request.handlers).toHaveLength(0);
  } finally {api.defaults.adapter=original;Object.defineProperty(window,'localStorage',descriptor);}
});
