from django.http import JsonResponse


def health(request):
    # A constant answer: liveness only.
    return JsonResponse({'status': 'ok'})
