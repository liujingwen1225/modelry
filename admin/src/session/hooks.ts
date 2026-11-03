import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { sessionApi, sessionKeys } from '@/api/session'

export function useBootstrapStatus() {
  return useQuery({
    queryKey: sessionKeys.bootstrap,
    queryFn: sessionApi.bootstrapStatus,
    retry: false,
    staleTime: 10_000,
  })
}

export function useAdminSession() {
  return useQuery({
    queryKey: sessionKeys.current,
    queryFn: sessionApi.current,
    retry: false,
    staleTime: 60_000,
  })
}

export function useCreateOwner() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => sessionApi.createOwner(input.email, input.password),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.bootstrap })
      void queryClient.invalidateQueries({ queryKey: sessionKeys.current })
    },
  })
}

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => sessionApi.login(input.email, input.password),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.current })
      void queryClient.invalidateQueries()
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => sessionApi.logout(),
    onSuccess: () => {
      queryClient.setQueryData(sessionKeys.current, undefined)
      void queryClient.invalidateQueries()
    },
  })
}
